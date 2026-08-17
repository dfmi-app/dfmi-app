// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * SessionKeyWallet — an account-abstraction-style agent wallet with revocable, scoped session keys.
 *
 * The problem it fixes: in a raw x402 / EIP-3009 setup an autonomous buying agent holds a funded key,
 * and a signed payment authorization is a bearer instrument. If the agent is compromised, the only
 * "revocation" is draining the wallet — you attack the money, not the authority.
 *
 * Here the agent's operating funds live in THIS contract. The agent never holds the owner key or the
 * funds directly — it holds only a session key that the owner granted with a spend cap and expiry, and
 * can kill at any moment. One revokeSession() tx instantly freezes a compromised agent: every later
 * payment it tries reverts. Funds stay safe, the account survives, the owner can still withdraw.
 *
 * Payment flow (agent-speed, offline-signed, no owner key in the loop):
 *   1. agent signs an EIP-712 Pay(to, amount, nonce, deadline) with its SESSION key
 *   2. anyone (a relayer / the facilitator) submits it via pay()
 *   3. the contract enforces: granted, not revoked, not expired, within cap, correct nonce, valid sig
 *
 * Revocation lives in the authorization path (the pay() gate), not in the balance. That is the point.
 */
contract SessionKeyWallet {
    address public owner;
    IERC20 public immutable token;

    struct Session {
        bool active; // owner can flip this false in one tx — the kill switch
        uint64 expiry; // unix seconds; 0 = never expires
        uint256 cap; // max cumulative spend over the session's life (token base units)
        uint256 spent; // cumulative spent so far
    }

    mapping(address => Session) public sessions; // sessionKey => Session
    mapping(address => uint256) public sessionNonce; // sessionKey => next expected nonce (replay guard)

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 private constant PAY_TYPEHASH =
        keccak256("Pay(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    event SessionGranted(address indexed sessionKey, uint256 cap, uint64 expiry);
    event SessionRevoked(address indexed sessionKey);
    event Paid(address indexed sessionKey, address indexed to, uint256 amount, uint256 nonce);
    event OwnerWithdraw(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _owner, address _token) {
        require(_owner != address(0) && _token != address(0), "zero arg");
        owner = _owner;
        token = IERC20(_token);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("dfmi SessionKeyWallet")),
                keccak256(bytes("1")),
                uint256(112172), // dfmi chainId, hardcoded to avoid the CHAINID opcode (Istanbul+) on the old AuRa chain
                address(this)
            )
        );
    }

    /// Owner grants an agent a scoped session key: a spend cap and an optional expiry.
    function grantSession(address sessionKey, uint256 cap, uint64 expiry) external onlyOwner {
        require(sessionKey != address(0), "zero key");
        sessions[sessionKey] = Session({active: true, expiry: expiry, cap: cap, spent: 0});
        emit SessionGranted(sessionKey, cap, expiry);
    }

    /// The kill switch. One tx, instant, irreversible for that key. Funds untouched, account survives.
    function revokeSession(address sessionKey) external onlyOwner {
        sessions[sessionKey].active = false;
        emit SessionRevoked(sessionKey);
    }

    /// Submit a payment the agent signed with its session key. Callable by anyone (relayer/facilitator);
    /// the signature — not msg.sender — is the authority, so this stays gasless for the agent.
    function pay(
        address sessionKey,
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Session storage s = sessions[sessionKey];
        require(s.active, "revoked or unknown session"); // <-- revocation gate, in the auth path
        require(s.expiry == 0 || block.timestamp <= s.expiry, "session expired");
        require(block.timestamp <= deadline, "payment deadline passed");
        require(nonce == sessionNonce[sessionKey], "bad nonce");
        require(s.spent + amount <= s.cap, "over session cap");

        bytes32 structHash = keccak256(abi.encode(PAY_TYPEHASH, to, amount, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(_recover(digest, signature) == sessionKey, "bad session signature");

        sessionNonce[sessionKey] = nonce + 1;
        s.spent += amount;
        require(token.transfer(to, amount), "token transfer failed");
        emit Paid(sessionKey, to, amount, nonce);
    }

    /// Owner can always pull funds back out — compromise of a session key never risks the principal.
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
