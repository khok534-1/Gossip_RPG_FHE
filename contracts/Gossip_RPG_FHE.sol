pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract GossipRPGFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error RateLimited();
    error InvalidBatch();
    error StaleWrite();
    error ReplayAttempt();
    error InvalidStateHash();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidCooldown();

    uint256 public constant MIN_INTERVAL = 5 seconds;
    uint256 public cooldownInterval = 5 seconds;
    uint256 public batchSizeLimit = 10;

    bool public paused;
    uint256 public modelVersion;
    uint256 public currentBatchId;
    bool public batchOpen;

    address public owner;
    mapping(address => bool) public providers;
    mapping(address => uint256) public lastActionAt;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Gossip {
        euint32 encryptedReputationDelta;
        uint256 version;
    }

    struct Batch {
        uint256 id;
        uint256 modelVersion;
        uint256 numGossips;
        bool closed;
        euint32 encryptedAggregateReputation;
    }

    struct DecryptionContext {
        uint256 modelId;
        uint256 version;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused();
    event Unpaused();
    event CooldownUpdated(uint256 oldInterval, uint256 newInterval);
    event BatchSizeLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event GossipSubmitted(address indexed submitter, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed requester);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, int32 aggregateReputation);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier rateLimited() {
        if (block.timestamp < lastActionAt[msg.sender] + cooldownInterval) {
            revert RateLimited();
        }
        lastActionAt[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        modelVersion = 1;
        currentBatchId = 1;
        batchOpen = false;
        batches[currentBatchId].id = currentBatchId;
        batches[currentBatchId].modelVersion = modelVersion;
        batches[currentBatchId].numGossips = 0;
        batches[currentBatchId].closed = true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit Paused();
        } else {
            paused = false;
            emit Unpaused();
        }
    }

    function setCooldownInterval(uint256 newInterval) external onlyOwner {
        if (newInterval < MIN_INTERVAL) revert InvalidCooldown();
        uint256 oldInterval = cooldownInterval;
        cooldownInterval = newInterval;
        emit CooldownUpdated(oldInterval, newInterval);
    }

    function setBatchSizeLimit(uint256 newLimit) external onlyOwner {
        uint256 oldLimit = batchSizeLimit;
        batchSizeLimit = newLimit;
        emit BatchSizeLimitUpdated(oldLimit, newLimit);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatch();
        currentBatchId++;
        batchOpen = true;
        batches[currentBatchId].id = currentBatchId;
        batches[currentBatchId].modelVersion = modelVersion;
        batches[currentBatchId].numGossips = 0;
        batches[currentBatchId].closed = false;
        batches[currentBatchId].encryptedAggregateReputation = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchClosed();
        batchOpen = false;
        batches[currentBatchId].closed = true;
        emit BatchClosed(currentBatchId);
    }

    function submitGossip(euint32 encryptedReputationDelta) external onlyProvider whenNotPaused rateLimited {
        if (!batchOpen) revert BatchClosed();
        if (batches[currentBatchId].numGossips >= batchSizeLimit) revert BatchClosed();
        if (batches[currentBatchId].closed) revert BatchClosed();

        batches[currentBatchId].numGossips++;
        batches[currentBatchId].encryptedAggregateReputation = FHE.add(
            batches[currentBatchId].encryptedAggregateReputation,
            encryptedReputationDelta
        );
        emit GossipSubmitted(msg.sender, currentBatchId);
    }

    function requestBatchDecryption(uint256 batchId) external whenNotPaused rateLimited {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (!batches[batchId].closed) revert BatchNotClosed();

        euint32 memory encryptedAggregate = batches[batchId].encryptedAggregateReputation;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedAggregate);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.handleBatchDecryption.selector);

        decryptionContexts[requestId] = DecryptionContext({
        modelId: 1, // FHE model ID
        version: batches[batchId].modelVersion,
        stateHash: stateHash,
        processed: false,
        requester: msg.sender
        });

        emit DecryptionRequested(requestId, batchId, msg.sender);
    }

    function handleBatchDecryption(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext storage context = decryptionContexts[requestId];
        if (context.processed) revert ReplayAttempt();

        Batch storage batch = batches[currentBatchId];
        euint32 memory encryptedAggregate = batch.encryptedAggregateReputation;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedAggregate);

        bytes32 currHash = _hashCiphertexts(cts);
        if (currHash != context.stateHash) revert InvalidStateHash();

        FHE.checkSignatures(requestId, cleartexts, proof);

        int32 aggregateReputation = abi.decode(cleartexts, (int32));
        context.processed = true;

        emit DecryptionCompleted(requestId, currentBatchId, aggregateReputation);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal pure returns (euint32 memory) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) {
            revert(string(abi.encodePacked(tag, " not initialized")));
        }
    }
}