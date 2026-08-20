// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IServiceRegistry {
    function categoryOf(address payTo) external view returns (uint8);
}

/**
 * IntentSessionWallet — SessionKeyWallet v2: the intent layer, constrained and honest.
 *
 * v1 (SessionKeyWallet) put revocation in the credential: cap, expiry, one revoke().
 * But its domain was still just "how much" and "until when". A compromised agent
 * could spend its whole cap on anything that answers a 402.
 *
 * v2 adds "what for": every session carries an intentMask — a 256-bit set of
 * allowed service categories (bit N = category N, from ServiceRegistry). pay()
 * resolves the payee's category and enforces membership IN THE AUTHORIZATION PATH,
 * next to the revocation gate — not in an audit log after the loss.
 *
 * "Only market-data services, 1.00 dUSD, 7 days" is now one grant:
 *   grantSession(key, 1_000000, expiry, 1 << 1)
 *
 * This is deliberately the *restricted* version of intent: category-scoped, not
 * open-world semantics. What it proves: intent enforcement needs no new
 * cryptography and no synchronous issuer hop — the missing piece for the full
 * problem is a shared semantic vocabulary, not enforcement machinery.
 *
 * The agent-side flow is unchanged from v1: same EIP-712 Pay, same domain name,
 * same relayer path. Intent lives in the grant, not in the signature.
 */
contract IntentSessionWallet {
    address public owner;
    IERC20 public immutable token;
    IServiceRegistry public immutable registry;

    struct Session {
        bool active;        // owner can flip false in one tx — kill switch #1
        uint64 expiry;      // unix seconds; 0 = never expires
        uint256 cap;        // max cumulative spend (token base units)
        uint256 spent;      // cumulative spent so far
        uint256 intentMask; // bit N set = category N allowed; 0 = unrestricted (v1 behavior)
    }

    mapping(address => Session) public sessions;
    mapping(address => uint256) public sessionNonce;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 private constant PAY_TYPEHASH =
        keccak256("Pay(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    event SessionGranted(address indexed sessionKey, uint256 cap, uint64 expiry, uint256 intentMask);
    event SessionRevoked(address indexed sessionKey);
    event Paid(address indexed sessionKey, address indexed to, uint256 amount, uint256 nonce, uint8 category);
    event OwnerWithdraw(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _owner, address _token, address _registry) {
        require(_owner != address(0) && _token != address(0) && _registry != address(0), "zero arg");
        owner = _owner;
        token = IERC20(_token);
        registry = IServiceRegistry(_registry);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("dfmi SessionKeyWallet")), // same domain as v1: agent code unchanged
                keccak256(bytes("1")),
                uint256(112172), // dfmi chainId, hardcoded (no CHAINID opcode on the old AuRa chain)
                address(this)
            )
        );
    }

    /// Grant a scoped session: spend cap, expiry, and an intent (category bitmask; 0 = unrestricted).
    function grantSession(address sessionKey, uint256 cap, uint64 expiry, uint256 intentMask) external onlyOwner {
        require(sessionKey != address(0), "zero key");
        sessions[sessionKey] = Session({active: true, expiry: expiry, cap: cap, spent: 0, intentMask: intentMask});
        emit SessionGranted(sessionKey, cap, expiry, intentMask);
    }

    /// Kill switch #1: cancel this credential. Funds untouched, account survives.
    function revokeSession(address sessionKey) external onlyOwner {
        sessions[sessionKey].active = false;
        emit SessionRevoked(sessionKey);
    }

    /// Can this session pay this payee right now? (facilitators pre-check here for clean errors)
    function allowed(address sessionKey, address to) external view returns (bool ok, uint8 category) {
        Session storage s = sessions[sessionKey];
        category = registry.categoryOf(to);
        if (!s.active) return (false, category);
        if (s.intentMask == 0) return (true, category);
        if (category == 0) return (false, 0);
        ok = (s.intentMask & (uint256(1) << category)) != 0;
    }

    /// Submit a payment the agent signed with its session key. The intent gate lives here,
    /// beside the revocation gate — in the authorization path.
    function pay(
        address sessionKey,
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Session storage s = sessions[sessionKey];
        require(s.active, "revoked or unknown session");
        require(s.expiry == 0 || block.timestamp <= s.expiry, "session expired");
        require(block.timestamp <= deadline, "payment deadline passed");
        require(nonce == sessionNonce[sessionKey], "bad nonce");
        require(s.spent + amount <= s.cap, "over session cap");

        uint8 category = 0;
        if (s.intentMask != 0) { // the intent gate
            category = registry.categoryOf(to);
            require(category != 0, "unregistered payee");
            require(s.intentMask & (uint256(1) << category) != 0, "outside intent");
        }

        bytes32 structHash = keccak256(abi.encode(PAY_TYPEHASH, to, amount, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(_recover(digest, signature) == sessionKey, "bad session signature");

        sessionNonce[sessionKey] = nonce + 1;
        s.spent += amount;
        require(token.transfer(to, amount), "token transfer failed");
        emit Paid(sessionKey, to, amount, nonce, category);
    }

    /// Owner can always pull funds out — no session, however scoped, risks the principal.
    function ownerWithdraw(address to, uint256 amount) external onlyOwner {
        require(token.transfer(to, amount), "withdraw failed");
        emit OwnerWithdraw(to, amount);
    }

    function remaining(address sessionKey) external view returns (uint256) {
        Session storage s = sessions[sessionKey];
        if (!s.active || s.cap < s.spent) return 0;
        return s.cap - s.spent;
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 vs;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            vs := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, vs);
    }
}
