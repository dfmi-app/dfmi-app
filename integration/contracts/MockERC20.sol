// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Minimal 6-decimals ERC20 for local EVM tests: transfer + balanceOf + mint. Not for production.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
}
