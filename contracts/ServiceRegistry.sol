// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ServiceRegistry — the vocabulary the intent layer speaks.
 *
 * An intent like "only market-data services" is enforceable only if "market-data"
 * means something on-chain. This registry gives every payout address a category:
 * a small, public, first-come-immutable label the wallet can read at pay() time.
 *
 * Category ids (documented convention, 1..255):
 *   1 = market-data      2 = ai-answers      3 = api-tools
 *   4 = media            5 = compute         6..255 = open
 *
 * Honest limits, stated up front: registration is first-come and self-declared.
 * A malicious seller can mis-categorize itself once. That narrows what this MVP
 * proves — intent *enforcement* works in the authorization path; trustworthy
 * category *attestation* (curator signatures, stake-and-challenge) is the next
 * problem, and it is an attestation problem, not an enforcement one.
 */
contract ServiceRegistry {
    mapping(address => uint8) public categoryOf; // payTo => category (0 = unregistered)

    event ServiceRegistered(address indexed payTo, uint8 indexed category, string label, address registrant);

    function register(address payTo, uint8 category, string calldata label) external {
        require(payTo != address(0) && category != 0, "bad args");
        require(categoryOf[payTo] == 0, "already registered"); // first come, immutable
        require(bytes(label).length <= 48, "label too long");
        categoryOf[payTo] = category;
        emit ServiceRegistered(payTo, category, label, msg.sender);
    }
}
