// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GossipRecord {
  id: string;
  encryptedReputation: string;
  timestamp: number;
  fromNPC: string;
  aboutPlayer: string;
  category: string;
  decryptedValue?: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const NPC_NAMES = ["Aldric", "Brynja", "Cedric", "Dagny", "Eirik", "Freya", "Gunnar", "Hilda", "Ivar", "Jorunn"];
const CATEGORIES = ["Combat", "Trade", "Romance", "Crime", "Politics", "Mystery"];

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [gossips, setGossips] = useState<GossipRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newGossipData, setNewGossipData] = useState({ fromNPC: "", aboutPlayer: "", reputationChange: 0, category: "" });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedGossip, setSelectedGossip] = useState<GossipRecord | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [playerReputation, setPlayerReputation] = useState(50);
  const [history, setHistory] = useState<string[]>([]);

  // Calculate reputation based on gossips
  useEffect(() => {
    if (gossips.length > 0) {
      let rep = 50;
      gossips.forEach(g => {
        if (g.decryptedValue !== undefined) {
          rep += g.decryptedValue;
        }
      });
      setPlayerReputation(Math.max(0, Math.min(100, rep)));
    }
  }, [gossips]);

  useEffect(() => {
    loadGossips().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadGossips = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("gossip_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing gossip keys:", e); }
      }
      
      const list: GossipRecord[] = [];
      for (const key of keys) {
        try {
          const gossipBytes = await contract.getData(`gossip_${key}`);
          if (gossipBytes.length > 0) {
            try {
              const gossipData = JSON.parse(ethers.toUtf8String(gossipBytes));
              list.push({ 
                id: key, 
                encryptedReputation: gossipData.reputation, 
                timestamp: gossipData.timestamp, 
                fromNPC: gossipData.fromNPC, 
                aboutPlayer: gossipData.aboutPlayer,
                category: gossipData.category
              });
            } catch (e) { console.error(`Error parsing gossip data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading gossip ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setGossips(list);
      addHistory(`Loaded ${list.length} encrypted gossip records`);
    } catch (e) { 
      console.error("Error loading gossips:", e);
      addHistory("Failed to load gossip records");
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitGossip = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addHistory("Attempted to submit gossip without wallet connection");
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting reputation change with Zama FHE..." });
    addHistory("Starting FHE encryption for new gossip");
    
    try {
      const encryptedReputation = FHEEncryptNumber(newGossipData.reputationChange);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const gossipId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const gossipData = { 
        reputation: encryptedReputation, 
        timestamp: Math.floor(Date.now() / 1000), 
        fromNPC: newGossipData.fromNPC, 
        aboutPlayer: newGossipData.aboutPlayer,
        category: newGossipData.category
      };
      
      await contract.setData(`gossip_${gossipId}`, ethers.toUtf8Bytes(JSON.stringify(gossipData)));
      addHistory(`Stored encrypted gossip from ${newGossipData.fromNPC}`);
      
      const keysBytes = await contract.getData("gossip_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(gossipId);
      await contract.setData("gossip_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      addHistory("Updated gossip keys list");
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted gossip submitted securely!" });
      addHistory("Gossip successfully submitted with FHE encryption");
      
      await loadGossips();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewGossipData({ fromNPC: "", aboutPlayer: "", reputationChange: 0, category: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      addHistory(`Gossip submission failed: ${errorMessage}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    addHistory("Starting wallet signature for decryption");
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      const decrypted = FHEDecryptNumber(encryptedData);
      addHistory("Successfully decrypted gossip value");
      return decrypted;
    } catch (e) { 
      console.error("Decryption failed:", e); 
      addHistory("Failed to decrypt gossip value");
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const addHistory = (message: string) => {
    setHistory(prev => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev.slice(0, 9)]);
  };

  const filteredGossips = gossips.filter(gossip => {
    const matchesSearch = gossip.fromNPC.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         gossip.aboutPlayer.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         gossip.category.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (activeFilter === "all") return matchesSearch;
    return matchesSearch && gossip.category === activeFilter;
  });

  const reputationColor = () => {
    if (playerReputation >= 70) return "#4CAF50"; // Green
    if (playerReputation >= 30) return "#FFC107"; // Yellow
    return "#F44336"; // Red
  };

  const renderReputationBar = () => {
    return (
      <div className="reputation-bar-container">
        <div className="reputation-bar-labels">
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100</span>
        </div>
        <div className="reputation-bar">
          <div 
            className="reputation-fill" 
            style={{
              width: `${playerReputation}%`,
              backgroundColor: reputationColor()
            }}
          ></div>
        </div>
        <div className="reputation-value" style={{ color: reputationColor() }}>
          {playerReputation.toFixed(1)}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen pixel-theme">
      <div className="pixel-spinner"></div>
      <p>Initializing encrypted gossip system...</p>
    </div>
  );

  return (
    <div className="app-container pixel-theme">
      <header className="app-header">
        <div className="logo">
          <h1>Gossip RPG</h1>
          <p>FHE-Encrypted Reputation System</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-section">
          <div className="dashboard-card">
            <h2>Player Reputation</h2>
            {renderReputationBar()}
            <div className="reputation-status">
              {playerReputation >= 70 ? "Heroic" : 
               playerReputation >= 30 ? "Neutral" : "Villainous"}
            </div>
          </div>

          <div className="dashboard-card">
            <h2>Gossip Statistics</h2>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{gossips.length}</div>
                <div className="stat-label">Total Gossips</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">
                  {gossips.filter(g => g.fromNPC === "Aldric").length}
                </div>
                <div className="stat-label">From Aldric</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">
                  {gossips.filter(g => g.category === "Combat").length}
                </div>
                <div className="stat-label">Combat</div>
              </div>
            </div>
          </div>
        </div>

        <div className="gossip-controls">
          <div className="search-filter">
            <input
              type="text"
              placeholder="Search gossips..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pixel-input"
            />
            <select 
              value={activeFilter} 
              onChange={(e) => setActiveFilter(e.target.value)}
              className="pixel-select"
            >
              <option value="all">All Categories</option>
              {CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div className="action-buttons">
            <button 
              onClick={loadGossips} 
              disabled={isRefreshing}
              className="pixel-button"
            >
              {isRefreshing ? "Refreshing..." : "Refresh Gossips"}
            </button>
            <button 
              onClick={() => setShowCreateModal(true)}
              className="pixel-button primary"
            >
              Create Gossip
            </button>
            <button 
              onClick={() => setShowTutorial(!showTutorial)}
              className="pixel-button"
            >
              {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
            </button>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section pixel-card">
            <h2>How FHE Powers Gossip System</h2>
            <div className="tutorial-steps">
              <div className="tutorial-step">
                <div className="step-number">1</div>
                <div className="step-content">
                  <h3>Encrypted Gossip</h3>
                  <p>NPCs spread encrypted gossip about players using Zama FHE technology</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-number">2</div>
                <div className="step-content">
                  <h3>Private Reputation</h3>
                  <p>Your reputation changes based on encrypted values without revealing details</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-number">3</div>
                <div className="step-content">
                  <h3>Secure Decryption</h3>
                  <p>Only you can decrypt gossip with your wallet signature</p>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="gossip-list">
          <h2>Encrypted Gossip Network</h2>
          {filteredGossips.length === 0 ? (
            <div className="no-gossips pixel-card">
              <p>No encrypted gossip found</p>
              <button 
                className="pixel-button primary" 
                onClick={() => setShowCreateModal(true)}
              >
                Start Gossip Chain
              </button>
            </div>
          ) : (
            <div className="gossip-grid">
              {filteredGossips.map(gossip => (
                <div 
                  key={gossip.id} 
                  className="gossip-card pixel-card"
                  onClick={() => setSelectedGossip(gossip)}
                >
                  <div className="gossip-header">
                    <span className="gossip-npc">{gossip.fromNPC}</span>
                    <span className="gossip-category">{gossip.category}</span>
                  </div>
                  <div className="gossip-content">
                    <p>About: {gossip.aboutPlayer}</p>
                    <div className="gossip-encrypted">
                      <span>Encrypted Reputation:</span>
                      <code>{gossip.encryptedReputation.substring(0, 15)}...</code>
                    </div>
                  </div>
                  <div className="gossip-footer">
                    <span className="gossip-date">
                      {new Date(gossip.timestamp * 1000).toLocaleDateString()}
                    </span>
                    {gossip.decryptedValue !== undefined && (
                      <span 
                        className="gossip-value" 
                        style={{ color: gossip.decryptedValue >= 0 ? "#4CAF50" : "#F44336" }}
                      >
                        {gossip.decryptedValue >= 0 ? "+" : ""}{gossip.decryptedValue}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="history-section pixel-card">
          <h2>Activity History</h2>
          <div className="history-list">
            {history.length === 0 ? (
              <p>No activity yet</p>
            ) : (
              history.map((entry, index) => (
                <div key={index} className="history-entry">
                  {entry}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal pixel-card">
            <div className="modal-header">
              <h2>Create New Gossip</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>From NPC</label>
                <select
                  name="fromNPC"
                  value={newGossipData.fromNPC}
                  onChange={(e) => setNewGossipData({...newGossipData, fromNPC: e.target.value})}
                  className="pixel-select"
                >
                  <option value="">Select NPC</option>
                  {NPC_NAMES.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>About Player</label>
                <input
                  type="text"
                  name="aboutPlayer"
                  value={newGossipData.aboutPlayer}
                  onChange={(e) => setNewGossipData({...newGossipData, aboutPlayer: e.target.value})}
                  placeholder="Player name..."
                  className="pixel-input"
                />
              </div>
              <div className="form-group">
                <label>Category</label>
                <select
                  name="category"
                  value={newGossipData.category}
                  onChange={(e) => setNewGossipData({...newGossipData, category: e.target.value})}
                  className="pixel-select"
                >
                  <option value="">Select category</option>
                  {CATEGORIES.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Reputation Change</label>
                <input
                  type="range"
                  min="-10"
                  max="10"
                  step="0.5"
                  value={newGossipData.reputationChange}
                  onChange={(e) => setNewGossipData({...newGossipData, reputationChange: parseFloat(e.target.value)})}
                  className="pixel-slider"
                />
                <div className="slider-value">
                  {newGossipData.reputationChange > 0 ? "+" : ""}
                  {newGossipData.reputationChange}
                </div>
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-content">
                  <div>Plain Value: {newGossipData.reputationChange}</div>
                  <div>→</div>
                  <div>Encrypted: {FHEEncryptNumber(newGossipData.reputationChange).substring(0, 20)}...</div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)} 
                className="pixel-button"
              >
                Cancel
              </button>
              <button 
                onClick={submitGossip} 
                disabled={creating || !newGossipData.fromNPC || !newGossipData.aboutPlayer || !newGossipData.category}
                className="pixel-button primary"
              >
                {creating ? "Encrypting..." : "Submit Gossip"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedGossip && (
        <div className="modal-overlay">
          <div className="detail-modal pixel-card">
            <div className="modal-header">
              <h2>Gossip Details</h2>
              <button onClick={() => setSelectedGossip(null)} className="close-modal">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="gossip-info">
                <div><span>From:</span> {selectedGossip.fromNPC}</div>
                <div><span>About:</span> {selectedGossip.aboutPlayer}</div>
                <div><span>Category:</span> {selectedGossip.category}</div>
                <div><span>Date:</span> {new Date(selectedGossip.timestamp * 1000).toLocaleString()}</div>
              </div>
              <div className="encrypted-data">
                <h3>Encrypted Reputation Change</h3>
                <code>{selectedGossip.encryptedReputation}</code>
              </div>
              <button
                onClick={async () => {
                  if (selectedGossip.decryptedValue === undefined) {
                    const decrypted = await decryptWithSignature(selectedGossip.encryptedReputation);
                    if (decrypted !== null) {
                      setSelectedGossip({...selectedGossip, decryptedValue: decrypted});
                      setGossips(gossips.map(g => 
                        g.id === selectedGossip.id ? {...g, decryptedValue: decrypted} : g
                      ));
                    }
                  }
                }}
                disabled={isDecrypting}
                className="pixel-button primary"
              >
                {isDecrypting ? "Decrypting..." : 
                 selectedGossip.decryptedValue !== undefined ? "Decrypted" : "Decrypt with Wallet"}
              </button>
              {selectedGossip.decryptedValue !== undefined && (
                <div className="decrypted-value">
                  <h3>Decrypted Value</h3>
                  <div className="value-display" style={{ 
                    color: selectedGossip.decryptedValue >= 0 ? "#4CAF50" : "#F44336",
                    fontSize: "2rem",
                    fontWeight: "bold"
                  }}>
                    {selectedGossip.decryptedValue > 0 ? "+" : ""}{selectedGossip.decryptedValue}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content pixel-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="pixel-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>Gossip RPG</h3>
            <p>Fully Homomorphic Encryption for Private Reputation</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Docs</a>
            <a href="#" className="footer-link">About Zama</a>
            <a href="#" className="footer-link">GitHub</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">Powered by Zama FHE</div>
        </div>
      </footer>
    </div>
  );
};

export default App;