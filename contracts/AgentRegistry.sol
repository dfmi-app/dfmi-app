// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AgentRegistry — the identity layer above session-key credentials.
 *
 * The credential answers "who signs" (a session key address). This registry answers
 * "who is the continuing subject behind the rotating keys". An owner registers an
 * agent once; every session key the agent is ever granted gets bound to that agentId.
 * History and reputation aggregate by agentId across key rotations, and the kill
 * switches now come in two grades:
 *
 *   revokeSession(key)   — cancel one card   (SessionKeyWallet: rotate, benign)
 *   deactivate(agentId)  — fire the agent    (this registry: identity-level)
 *
 * Deliberately minimal, like SessionKeyWallet: no admin, no fees, one global
 * append-only table anyone can register into, ownership enforced per agent.
 */
contract AgentRegistry {
    struct Agent { address owner; uint64 createdAt; bool active; string name; }

    Agent[] private _agents;
    mapping(address => uint256) private _keyToAgent; // sessionKey => agentId + 1 (0 = unbound)

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string name);
    event AgentDeactivated(uint256 indexed agentId);
    event KeyBound(uint256 indexed agentId, address indexed key);
    event KeyUnbound(uint256 indexed agentId, address indexed key);

    modifier onlyAgentOwner(uint256 agentId) {
        require(agentId < _agents.length, "no such agent");
        require(_agents[agentId].owner == msg.sender, "not agent owner");
        _;
    }

    /// Register a new agent identity. Returns its permanent agentId.
    function register(string calldata name) external returns (uint256 agentId) {
        require(bytes(name).length > 0 && bytes(name).length <= 64, "bad name");
        agentId = _agents.length;
        _agents.push(Agent({owner: msg.sender, createdAt: uint64(block.timestamp), active: true, name: name}));
        emit AgentRegistered(agentId, msg.sender, name);
    }

    /// Bind a session key to an agent. A key belongs to at most one agent, ever bound by its owner.
    function bindKey(uint256 agentId, address key) external onlyAgentOwner(agentId) {
        require(key != address(0), "zero key");
        require(_agents[agentId].active, "agent deactivated");
        uint256 cur = _keyToAgent[key];
        require(cur == 0 || cur == agentId + 1, "key bound to another agent");
        _keyToAgent[key] = agentId + 1;
        emit KeyBound(agentId, key);
    }

    function unbindKey(address key) external {
        uint256 cur = _keyToAgent[key];
        require(cur != 0, "key not bound");
        require(_agents[cur - 1].owner == msg.sender, "not agent owner");
        _keyToAgent[key] = 0;
        emit KeyUnbound(cur - 1, key);
    }

    /// Identity-level kill switch. Irreversible; bound keys stay attributed for history.
    function deactivate(uint256 agentId) external onlyAgentOwner(agentId) {
        _agents[agentId].active = false;
        emit AgentDeactivated(agentId);
    }

    function agentCount() external view returns (uint256) { return _agents.length; }

    function getAgent(uint256 agentId) external view returns (address owner, string memory name, bool active, uint64 createdAt) {
        require(agentId < _agents.length, "no such agent");
        Agent storage a = _agents[agentId];
        return (a.owner, a.name, a.active, a.createdAt);
    }

    /// agentId + 1 for a bound key; 0 if unbound.
    function agentOf(address key) external view returns (uint256) { return _keyToAgent[key]; }

    /// Convenience for indexers: the display name behind a key ("" if unbound).
    function agentNameOf(address key) external view returns (string memory) {
        uint256 id = _keyToAgent[key];
        if (id == 0) return "";
        return _agents[id - 1].name;
    }
}
