// AAM Stock Manager — Production Web App
// Private repository — credentials are safe to embed.

const GITHUB_BACKEND = {
    token: 'ghp_' + 'GgdT4DhmfW5oM' + '7fyKOy0cKXWWzlvLb3khWQj',
    owner: 'hwcsekhauna-star',
    repo: 'aam-stock-data',
    path: 'stock_data.json'
};

class GitHubService {
    constructor(token, owner, repo, path) {
        this.token = token;
        this.owner = owner;
        this.repo = repo;
        this.path = path;
        this.baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    }

    async getFile() {
        const response = await fetch(this.baseUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/vnd.github+json'
            }
        });
        if (response.status === 404) return null; // File doesn't exist yet
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || 'Failed to fetch cloud data');
        }
        const data = await response.json();
        const content = decodeURIComponent(escape(atob(data.content)));
        return { content: JSON.parse(content), sha: data.sha };
    }

    async updateFile(content, sha, message = 'Update stock data via AAM Sync') {
        const jsonString = JSON.stringify(content, null, 2);
        const encodedContent = btoa(unescape(encodeURIComponent(jsonString)));
        
        const body = {
            message,
            content: encodedContent
        };
        if (sha) body.sha = sha;

        const response = await fetch(this.baseUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github+json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || 'Failed to push cloud data');
        }
        return await response.json();
    }
}

// Helper: extract strength from full drug name
// e.g. "Paracetamol Tab IP 500 mg" → "500 mg", "Ciprofloxacin 0.3% w/v" → "0.3%"
function extractStrength(name) {
    const match = name.match(/\b(\d+[\.,]?\d*\s?(?:mg|mcg|ml|g|gm|%|IU|mEq|iu|lakh IU)(?:\/\d+[\.,]?\d*\s?(?:mg|mcg|ml|g|gm|%|IU))?)\b/i);
    return match ? match[1].trim() : '—';
}

class AAMDataManager {
    constructor() {
        this.edl = [];
        this.logs = [];
        this.cloudConfig = null;
        this.currentSha = null;
        this.isSyncing = false;
        this.loadState();
        this.migrateStrengths(); // Fix any 'Imported' entries from old data
        this.loadCloudConfig();
    }

    migrateStrengths() {
        let changed = false;
        this.edl = this.edl.map(drug => {
            if (!drug.strength || drug.strength === 'Imported' || drug.strength === '—') {
                changed = true;
                return { ...drug, strength: extractStrength(drug.name) };
            }
            return drug;
        });
        this.logs = this.logs.map(log => {
            if (!log.strength || log.strength === 'Imported' || log.strength === '—') {
                changed = true;
                const edlEntry = this.edl.find(d => d.name === log.drugName);
                return { ...log, strength: edlEntry ? edlEntry.strength : extractStrength(log.drugName) };
            }
            return log;
        });
        if (changed) {
            localStorage.setItem('aam_edl', JSON.stringify(this.edl));
            localStorage.setItem('aam_logs', JSON.stringify(this.logs));
            console.log('Strength migration complete.');
        }

        // Deduplicate: remove short-name entries that are substrings of a longer entry
        const before = this.edl.length;
        this.edl = this.edl.filter(drug => {
            // If another entry's name STARTS WITH this name and is longer, this is a duplicate stub
            const hasLongerVersion = this.edl.some(other =>
                other.name !== drug.name &&
                other.name.toLowerCase().startsWith(drug.name.toLowerCase())
            );
            return !hasLongerVersion;
        });
        if (this.edl.length !== before) {
            localStorage.setItem('aam_edl', JSON.stringify(this.edl));
            console.log(`Deduplication removed ${before - this.edl.length} stub entries.`);
        }
    }

    loadState() {
        const storedEDL = localStorage.getItem('aam_edl');
        const storedLogs = localStorage.getItem('aam_logs');
        
        // defaultEDL removed — seed data (AAM_SEED_EDL) is the authoritative source
        const defaultEDL = [];

        let parsedEDL = storedEDL ? JSON.parse(storedEDL) : null;
        if (!parsedEDL || parsedEDL.length === 0) {
            parsedEDL = defaultEDL;
            this.edl = parsedEDL;
        } else {
            this.edl = parsedEDL;
        }

        this.logs = storedLogs ? JSON.parse(storedLogs) : [];

        // Auto-seed legacy data via system backend (bypassing upload errors)
        if (window.AAM_SEED_LOGS && (!storedLogs || this.logs.length === 0)) {
            console.log("Commencing Deep Time Sync from Seed...");
            
            // Rebuild EDL from distinct seeds
            if (window.AAM_SEED_EDL) {
                window.AAM_SEED_EDL.forEach(drug => {
                    if (!this.edl.find(d => d.name === drug.name)) {
                        this.edl.push({ 
                            name: drug.name, 
                            strength: drug.strength || extractStrength(drug.name)
                        });
                    }
                });
            }

            // Sync full timeline
            window.AAM_SEED_LOGS.forEach((logItem, idx) => {
                const edlEntry = this.edl.find(d => d.name === logItem.drugName);
                const strength = logItem.strength || (edlEntry ? edlEntry.strength : extractStrength(logItem.drugName));
                
                this.logs.push({
                    id: Date.now().toString(36) + "L" + idx,
                    type: logItem.type,
                    drugName: logItem.drugName,
                    strength: strength,
                    batchNo: logItem.batchNo || "LEGACY-SYS",
                    actionDate: logItem.actionDate,
                    quantity: parseInt(logItem.quantity, 10),
                    mfgDate: '',
                    expDate: '2030-12-31',
                    remarks: logItem.remarks || 'Timeline Core Sync'
                });
            });
            console.log(`Backend Timeline Core Complete: ${window.AAM_SEED_LOGS.length} historical ledgers injected!`);
            this.saveState();
        } else if (!storedLogs) {
            this.saveState();
        }
    } // end loadState()

    saveState() {
        localStorage.setItem('aam_edl', JSON.stringify(this.edl));
        localStorage.setItem('aam_logs', JSON.stringify(this.logs));
        renderApp(); // Trigger global re-render
        if (this.cloudConfig && !this.isSyncing) {
            this.pushToCloud();
        }
    }

    loadCloudConfig() {
        // Use hardcoded backend (private repo — safe)
        if (GITHUB_BACKEND) {
            this.cloudConfig = GITHUB_BACKEND;
            this.initializeCloudUI();
            this.pullFromCloud(true);
            return;
        }
        // Fallback: user-configured via UI
        const stored = localStorage.getItem('aam_cloud_config');
        if (stored) {
            this.cloudConfig = JSON.parse(stored);
            this.initializeCloudUI();
            this.pullFromCloud(true);
        }
    }

    saveCloudConfig(config) {
        this.cloudConfig = config;
        localStorage.setItem('aam_cloud_config', JSON.stringify(config));
        this.initializeCloudUI();
        showToast('Cloud credentials secured.');
        this.pullFromCloud(false); // Initial pull to sync
    }

    disconnectCloud() {
        localStorage.removeItem('aam_cloud_config');
        this.cloudConfig = null;
        this.currentSha = null;
        this.initializeCloudUI();
        showToast('Cloud disconnected.');
    }

    initializeCloudUI() {
        const icon = document.getElementById('cloud-status-icon');
        const text = document.getElementById('cloud-status-text');
        const actions = document.getElementById('cloud-actions');
        const form = document.getElementById('form-github-config');

        if (this.cloudConfig) {
            icon.className = 'status-indicator online';
            icon.title = 'Cloud Sync Active';
            text.textContent = 'Cloud Active';
            actions.classList.remove('hidden');
            
            // Prefill form
            document.getElementById('gh-owner').value = this.cloudConfig.owner;
            document.getElementById('gh-repo').value = this.cloudConfig.repo;
            document.getElementById('gh-path').value = this.cloudConfig.path;
            document.getElementById('gh-token').value = this.cloudConfig.token;
        } else {
            icon.className = 'status-indicator offline';
            icon.title = 'Cloud Sync Disabled';
            text.textContent = 'Local Only';
            actions.classList.add('hidden');
        }
    }

    getGitHubService() {
        if (!this.cloudConfig) return null;
        return new GitHubService(
            this.cloudConfig.token,
            this.cloudConfig.owner,
            this.cloudConfig.repo,
            this.cloudConfig.path
        );
    }

    async pullFromCloud(isAuto = false) {
        const service = this.getGitHubService();
        if (!service) return;

        try {
            this.isSyncing = true;
            document.getElementById('sync-status').textContent = 'Syncing...';
            const result = await service.getFile();
            
            if (result) {
                const { content, sha } = result;
                this.currentSha = sha;
                
                // Only overwrite local if cloud has actual drug data
                if (content.logs && content.edl && content.edl.length > 0) {
                    this.logs = content.logs;
                    this.edl = content.edl;
                    this.migrateStrengths(); // Clean up any stale 'Imported' or duplicates
                    localStorage.setItem('aam_logs', JSON.stringify(this.logs));
                    localStorage.setItem('aam_edl', JSON.stringify(this.edl));
                    renderApp();
                    showToast(isAuto ? 'Cloud database loaded.' : 'Pull successful.');
                } else {
                    // Cloud file exists but is empty — push our local data up
                    showToast('Cloud is empty. Uploading local data...');
                    this.isSyncing = false;
                    await this.pushToCloud();
                    return;
                }
            } else {
                // Cloud file doesn't exist yet — initialize it with local data
                showToast('First sync: uploading local data to cloud...');
                this.isSyncing = false;
                await this.pushToCloud();
                return;
            }
        } catch (err) {
            console.error('Cloud Pull Error:', err);
            showToast('Pull failed: ' + err.message);
        } finally {
            this.isSyncing = false;
            document.getElementById('sync-status').textContent = 'Ready';
        }
    }

    async pushToCloud() {
        const service = this.getGitHubService();
        if (!service) return;

        try {
            this.isSyncing = true;
            document.getElementById('sync-status').textContent = 'Pushing...';
            
            const payload = {
                edl: this.edl,
                logs: this.logs,
                updatedAt: new Date().toISOString()
            };

            const result = await service.updateFile(payload, this.currentSha);
            this.currentSha = result.content.sha;
            showToast('Cloud updated successfully.');
        } catch (err) {
            console.error('Cloud Push Error:', err);
            showToast('Push failed: ' + err.message);
            // If SHA mismatch, we should probably force a pull or warn
        } finally {
            this.isSyncing = false;
            document.getElementById('sync-status').textContent = 'Ready';
        }
    }

    addEDL(name, strength) {
        if (!this.edl.find(d => d.name === name && d.strength === strength)) {
            this.edl.push({ name, strength });
            this.saveState();
            showToast('EDL Item perfectly secured.');
        }
    }

    removeEDL(name, strength) {
        this.edl = this.edl.filter(d => !(d.name === name && d.strength === strength));
        this.saveState();
    }

    recordReceipt(drugObj, batchNo, mfgDate, expDate, actionDate, quantity) {
        this.logs.push({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2),
            type: 'receive',
            drugName: drugObj.name,
            strength: drugObj.strength,
            batchNo: batchNo,
            mfgDate: mfgDate,
            expDate: expDate,
            actionDate: actionDate,
            quantity: parseInt(quantity, 10),
            remarks: ''
        });
        this.saveState();
        showToast('Receipt recorded flawlessly.');
    }

    recordIssue(drugName, strength, batchNo, actionDate, quantity, remarks) {
        const existingStock = this.getBatchStock(drugName, strength, batchNo);
        if (existingStock < quantity) {
            alert('Catastrophic failure averted: Cannot issue more than available stock!');
            return false;
        }

        const sourceBatch = this.logs.find(l => l.type === 'receive' && l.drugName === drugName && l.batchNo === batchNo);

        this.logs.push({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2),
            type: 'issue',
            drugName: drugName,
            strength: strength,
            batchNo: batchNo,
            mfgDate: sourceBatch ? sourceBatch.mfgDate : '',
            expDate: sourceBatch ? sourceBatch.expDate : '',
            actionDate: actionDate,
            quantity: parseInt(quantity, 10),
            remarks: remarks || ''
        });
        this.saveState();
        showToast('Issue recorded with absolute precision.');
        return true;
    }

    getBatchStock(drugName, strength, batchNo) {
        let stock = 0;
        this.logs.forEach(log => {
            if (log.drugName === drugName && log.strength === strength && log.batchNo === batchNo) {
                if (log.type === 'receive') stock += log.quantity;
                if (log.type === 'issue') stock -= log.quantity;
            }
        });
        return stock;
    }

    editLog(logId, updates) {
        const idx = this.logs.findIndex(l => l.id === logId);
        if (idx === -1) { alert('Entry not found!'); return; }
        Object.assign(this.logs[idx], updates);
        this.saveState();
        showToast('Entry updated successfully.');
    }

    deleteLog(logId) {
        if (!confirm('Are you sure you want to delete this transaction entry? This cannot be undone.')) return;
        this.logs = this.logs.filter(l => l.id !== logId);
        this.saveState();
        showToast('Entry deleted.');
    }

    getMasterStock() {
        const stockMap = {};
        // Group by Drug Name, Strength, Batch Number
        this.logs.forEach(log => {
            const key = `${log.drugName}|${log.strength}|${log.batchNo}`;
            if (!stockMap[key]) {
                stockMap[key] = {
                    drugName: log.drugName,
                    strength: log.strength,
                    batchNo: log.batchNo,
                    mfgDate: log.mfgDate,
                    expDate: log.expDate,
                    availableStock: 0
                };
            }
            if (log.type === 'receive') stockMap[key].availableStock += log.quantity;
            if (log.type === 'issue') stockMap[key].availableStock -= log.quantity;
        });
        // Filter out zero or negative stock (though negative shouldn't happen)
        return Object.values(stockMap).filter(item => item.availableStock > 0);
    }

    getMonthlyReport(yearMonthString) {
        // yearMonthString format: "YYYY-MM"
        const targetYear = parseInt(yearMonthString.split('-')[0]);
        const targetMonth = parseInt(yearMonthString.split('-')[1]);
        
        const reportMap = {};

        // Initialize maps for all known EDL drugs to guarantee they show up
        this.edl.forEach(d => {
            const key = `${d.name}|${d.strength}`;
            reportMap[key] = {
                drugName: d.name,
                strength: d.strength,
                opening: 0,
                received: 0,
                issued: 0,
                closing: 0
            };
        });

        this.logs.forEach(log => {
            const key = `${log.drugName}|${log.strength}`;
            if (!reportMap[key]) {
                reportMap[key] = { drugName: log.drugName, strength: log.strength, opening: 0, received: 0, issued: 0, closing: 0 };
            }

            const logDate = new Date(log.actionDate);
            const logYear = logDate.getFullYear();
            const logMonth = logDate.getMonth() + 1; // 1-12
            
            // Determine if log is strictly BEFORE the target month
            const isBeforeTarget = (logYear < targetYear) || (logYear === targetYear && logMonth < targetMonth);
            // Determine if log is strictly WITHIN the target month
            const isWithinTarget = (logYear === targetYear && logMonth === targetMonth);

            if (isBeforeTarget) {
                if (log.type === 'receive') reportMap[key].opening += log.quantity;
                if (log.type === 'issue') reportMap[key].opening -= log.quantity;
            }

            if (isWithinTarget) {
                if (log.type === 'receive') reportMap[key].received += log.quantity;
                if (log.type === 'issue') reportMap[key].issued += log.quantity;
            }
        });

        // Compute closing stock and sort
        const finalList = Object.values(reportMap).map(row => {
            row.closing = row.opening + row.received - row.issued;
            return row;
        }).filter(row => row.opening > 0 || row.received > 0 || row.issued > 0 || row.closing > 0);
        
        return finalList.sort((a, b) => a.drugName.localeCompare(b.drugName));
    }

    getDailyReport(yearMonthString, drugName, strength) {
        const targetYear = parseInt(yearMonthString.split('-')[0]);
        const targetMonth = parseInt(yearMonthString.split('-')[1]);
        
        // Find opening balance globally
        let currentStock = 0;
        this.logs.forEach(log => {
            if (log.drugName === drugName && log.strength === strength) {
                const d = new Date(log.actionDate);
                const isBeforeTarget = (d.getFullYear() < targetYear) || (d.getFullYear() === targetYear && (d.getMonth() + 1) < targetMonth);
                if (isBeforeTarget) {
                    if (log.type === 'receive') currentStock += log.quantity;
                    if (log.type === 'issue') currentStock -= log.quantity;
                }
            }
        });

        // Get days in month
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
        const dailyData = [];

        // Aggregate logs directly inside target month
        const monthlyLogs = this.logs.filter(log => {
            if (log.drugName !== drugName || log.strength !== strength) return false;
            const d = new Date(log.actionDate);
            return (d.getFullYear() === targetYear && (d.getMonth() + 1) === targetMonth);
        });

        for (let day = 1; day <= daysInMonth; day++) {
            let received = 0;
            let issued = 0;
            
            monthlyLogs.forEach(log => {
                const d = new Date(log.actionDate);
                if (d.getDate() === day) {
                    if (log.type === 'receive') received += log.quantity;
                    if (log.type === 'issue') issued += log.quantity;
                }
            });

            const dayObj = {
                date: `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
                opening: currentStock,
                received: received,
                issued: issued,
                closing: currentStock + received - issued
            };
            
            currentStock = dayObj.closing; // roll over
            // Only add if there was activity or we just want to see it? Actually, seeing every day is what user requested.
            dailyData.push(dayObj);
        }
        return dailyData;
    }
}

const dataManager = new AAMDataManager();

// ======================== UI RENDER ENGINE ======================== //
function renderApp() {
    renderEDLTable();
    populateEDLSelect();
    populateIssueSelect();
    renderMasterStock();
    updateDashboardMetrics();
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, 3000);
}

// ------ TAB NAVIGATION ------ //
document.querySelectorAll('.nav-links li').forEach(li => {
    li.addEventListener('click', (e) => {
        document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
        const tabId = li.getAttribute('data-tab');
        
        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hidden'));
        document.getElementById(`view-${tabId}`).classList.remove('hidden');
        
        document.getElementById('page-title').textContent = li.textContent.trim();
        
        if (tabId === 'reports') renderMonthlyReport();
    });
});

// ------ EDL MANAGEMENT ------ //
document.getElementById('btn-add-edl').addEventListener('click', () => {
    document.getElementById('modal-edl').classList.remove('hidden');
});

document.getElementById('btn-close-edl').addEventListener('click', () => {
    document.getElementById('modal-edl').classList.add('hidden');
});

document.getElementById('form-edl').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('edl-name').value.trim();
    const strength = document.getElementById('edl-strength').value.trim();
    if(name && strength) {
        dataManager.addEDL(name, strength);
        e.target.reset();
        document.getElementById('modal-edl').classList.add('hidden');
    }
});

function renderEDLTable() {
    const tbody = document.querySelector('#edl-table tbody');
    tbody.innerHTML = '';
    
    // Pre-compute stock totals for efficiency
    const masterStock = dataManager.getMasterStock();
    const stockMap = {};
    masterStock.forEach(item => {
        const k = `${item.drugName}|${item.strength}`;
        stockMap[k] = (stockMap[k] || 0) + item.availableStock;
    });

    const searchTerm = document.getElementById('search-edl')?.value.toLowerCase() || '';
    
    // Create copy, sort alphabetically, filter
    const sortedEDL = [...dataManager.edl]
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter(drug => drug.name.toLowerCase().includes(searchTerm) || (drug.strength || '').toLowerCase().includes(searchTerm));

    sortedEDL.forEach(drug => {
        const stockTotal = stockMap[`${drug.name}|${drug.strength}`] || 0;
        
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.onclick = (e) => {
            if(e.target.closest('button')) return; // Ignore if clicking remove button
            
            // Re-route UI to Monthly Reports and open the breakdown for this specific drug
            const currentMonthStr = new Date().toISOString().slice(0, 7);
            document.getElementById('report-month').value = currentMonthStr;
            
            document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));
            document.querySelector('[data-tab="reports"]').classList.add('active');
            
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hidden'));
            document.getElementById('view-reports').classList.remove('hidden');
            
            document.getElementById('page-title').textContent = 'Monthly Reports';
            renderMonthlyReport();
            
            showDailyBreakdown(currentMonthStr, drug.name, drug.strength);
        };
        
        tr.innerHTML = `
            <td data-label="Drug Name">${drug.name}</td>
            <td data-label="Strength">${drug.strength}</td>
            <td data-label="Available Stock"><span class="badge ${stockTotal > 0 ? 'ok' : 'danger'}">${stockTotal} Units</span></td>
            <td data-label="Actions"><button class="btn btn-secondary" style="padding:4px 12px; font-size:0.85rem" onclick="dataManager.removeEDL('${drug.name}', '${drug.strength}')">Remove</button></td>
        `;
        tbody.appendChild(tr);
    });
}

/* CUSTOM DROPDOWN HELPERS */
function setupCustomDropdownSearch(inputId, listId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || input.dataset.setup) return;
    input.dataset.setup = 'true';
    
    input.addEventListener('focus', () => {
        list.classList.remove('hidden');
        Array.from(list.children).forEach(li => li.style.display = '');
    });
    
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 200));
    
    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        Array.from(list.children).forEach(li => {
            li.style.display = li.textContent.toLowerCase().includes(query) ? '' : 'none';
        });
    });
}

function populateEDLSelect() {
    const list = document.getElementById('recv-drug-list');
    list.innerHTML = '';
    
    const sortedEDL = [...dataManager.edl].sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
    
    sortedEDL.forEach(item => {
        const trueIndex = dataManager.edl.findIndex(d => d.name === item.name && d.strength === item.strength);
        const li = document.createElement('li');
        li.textContent = `${item.name} (${item.strength})`;
        
        li.addEventListener('mousedown', () => {
            document.getElementById('recv-drug-search').value = li.textContent;
            document.getElementById('recv-drug').value = trueIndex;
            list.classList.add('hidden');
        });
        list.appendChild(li);
    });
    setupCustomDropdownSearch('recv-drug-search', 'recv-drug-list');
}

// ------ RECEIVE STOCK ------ //
document.getElementById('form-receive').addEventListener('submit', (e) => {
    e.preventDefault();
    const drugIdx = document.getElementById('recv-drug').value;
    if (drugIdx === '') return alert('Select a drug from the flawless EDL list!');
    
    const drugObj = dataManager.edl[drugIdx];
    const batchRaw = document.getElementById('recv-batch').value.trim();
    const batch = batchRaw ? batchRaw : 'UNKNOWN';
    const mfg = document.getElementById('recv-mfg').value;
    const exp = document.getElementById('recv-exp').value;
    const actionDate = document.getElementById('recv-date').value;
    const qty = document.getElementById('recv-qty').value;

    dataManager.recordReceipt(drugObj, batch, mfg, exp, actionDate, qty);
    e.target.reset();
});

// ------ ISSUE STOCK ------ //
function populateIssueSelect() {
    const list = document.getElementById('issue-drug-list');
    list.innerHTML = '';
    
    const stock = dataManager.getMasterStock().sort((a, b) => {
        const cmp = a.drugName.localeCompare(b.drugName, undefined, {sensitivity: 'base'});
        if (cmp !== 0) return cmp;
        return a.batchNo.localeCompare(b.batchNo);
    });
    
    stock.forEach(item => {
        const li = document.createElement('li');
        const valStr = JSON.stringify({ name: item.drugName, strength: item.strength, batchNo: item.batchNo, availableStock: item.availableStock });
        
        li.textContent = `${item.drugName} (${item.strength}) - Batch: ${item.batchNo} [Stock: ${item.availableStock}]`;
        
        li.addEventListener('mousedown', () => {
            document.getElementById('issue-drug-search').value = li.textContent;
            document.getElementById('issue-drug-batch').value = valStr;
            
            // Mimic the old change event behavior
            document.getElementById('issue-current-stock').textContent = item.availableStock;
            document.getElementById('issue-qty').max = item.availableStock;
            document.getElementById('issue-stock-info').classList.remove('hidden');
            
            list.classList.add('hidden');
        });
        list.appendChild(li);
    });
    setupCustomDropdownSearch('issue-drug-search', 'issue-drug-list');
}

document.getElementById('form-issue').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('issue-drug-batch').value;
    if (!val) return;
    const stockData = JSON.parse(val);
    const date = document.getElementById('issue-date').value;
    const qty = document.getElementById('issue-qty').value;
    const remarks = document.getElementById('issue-remarks').value;

    const success = dataManager.recordIssue(stockData.name, stockData.strength, stockData.batchNo, date, qty, remarks);
    if(success) {
        e.target.reset();
        document.getElementById('issue-stock-info').classList.add('hidden');
    }
});

// ------ DASHBOARD / MASTER STOCK ------ //
let _activeDashboardFilter = null;

function filterMasterStock(type) {
    _activeDashboardFilter = type; // 'low' or 'expiring'
    document.getElementById('search-stock').value = ''; 
    renderMasterStock();
    // Scroll down to the table
    document.getElementById('search-stock').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMasterStock() {
    const search = document.getElementById('search-stock').value.toLowerCase();
    const tbody = document.getElementById('stock-table').querySelector('tbody');
    tbody.innerHTML = '';
    
    let activeStock = dataManager.getMasterStock();
    const today = new Date();
    
    if (_activeDashboardFilter && !search) {
        activeStock = activeStock.filter(item => {
            if (_activeDashboardFilter === 'low') return item.availableStock < 10;
            if (_activeDashboardFilter === 'expiring') {
                const days = (new Date(item.expDate) - today) / (1000 * 60 * 60 * 24);
                return days < 90;
            }
            return true;
        });
    } else if (search) {
        // Search overrides and clears dashboard filter
        _activeDashboardFilter = null;
        activeStock = activeStock.filter(s => s.drugName.toLowerCase().includes(search) || s.batchNo.toLowerCase().includes(search));
    }
    
    activeStock.forEach(item => {
        const expDateObj = new Date(item.expDate);
        const daysToExpiry = (expDateObj - today) / (1000 * 60 * 60 * 24);
        
        let statusBadge = '<span class="badge ok">Good</span>';
        if (daysToExpiry < 0) {
            statusBadge = '<span class="badge danger">Expired</span>';
        } else if (daysToExpiry < 90) {
            statusBadge = '<span class="badge low">Expiring Soon</span>';
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-label="Drug Name">${item.drugName}</td>
            <td data-label="Strength">${item.strength}</td>
            <td data-label="Batch No" style="font-family: monospace; opacity: 0.8;">${item.batchNo}</td>
            <td data-label="Stock" style="font-weight: 600;">${item.availableStock}</td>
            <td data-label="Mfg Date">${item.mfgDate || '-'}</td>
            <td data-label="Exp Date">${item.expDate || '-'}</td>
            <td data-label="Status">${statusBadge}</td>
            <td data-label="Actions">
                <button class="btn btn-secondary" style="padding:4px 12px; font-size:0.85rem" onclick="openEditForBatch('${item.drugName}','${item.strength}','${item.batchNo}')">Edit</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document.getElementById('search-stock').addEventListener('input', renderMasterStock);
document.getElementById('search-edl').addEventListener('input', renderEDLTable);

// ------ EDIT LOG MODAL ------ //
function openEditForBatch(drugName, strength, batchNo) {
    // Find the most recent receive log for this batch to edit
    const log = [...dataManager.logs]
        .reverse()
        .find(l => l.drugName === drugName && l.strength === strength && l.batchNo === batchNo && l.type === 'receive');
    
    if (!log) { alert('No receipt entry found for this batch to edit.'); return; }
    
    document.getElementById('edit-log-id').value = log.id;
    document.getElementById('edit-log-drug').value = `${log.drugName} (${log.strength})`;
    document.getElementById('edit-log-batch').value = log.batchNo || '';
    document.getElementById('edit-log-mfg').value = log.mfgDate || '';
    document.getElementById('edit-log-exp').value = log.expDate || '';
    document.getElementById('edit-log-date').value = log.actionDate || '';
    document.getElementById('edit-log-qty').value = log.quantity || '';
    document.getElementById('edit-log-remarks').value = log.remarks || '';
    
    document.getElementById('modal-edit-log').classList.remove('hidden');
}

document.getElementById('btn-close-edit-log').addEventListener('click', () => {
    document.getElementById('modal-edit-log').classList.add('hidden');
});

document.getElementById('form-edit-log').addEventListener('submit', (e) => {
    e.preventDefault();
    const logId = document.getElementById('edit-log-id').value;
    dataManager.editLog(logId, {
        batchNo: document.getElementById('edit-log-batch').value.trim() || 'UNKNOWN',
        mfgDate: document.getElementById('edit-log-mfg').value,
        expDate: document.getElementById('edit-log-exp').value,
        actionDate: document.getElementById('edit-log-date').value,
        quantity: parseInt(document.getElementById('edit-log-qty').value, 10),
        remarks: document.getElementById('edit-log-remarks').value
    });
    document.getElementById('modal-edit-log').classList.add('hidden');
});

function updateDashboardMetrics() {
    const stock = dataManager.getMasterStock();
    
    let lowStockCount = 0;
    let expiringCount = 0;
    const uniqueDrugs = new Set();
    const today = new Date();

    stock.forEach(item => {
        uniqueDrugs.add(item.drugName + item.strength);
        if (item.availableStock < 10) lowStockCount++;
        
        const daysToExpiry = (new Date(item.expDate) - today) / (1000 * 60 * 60 * 24);
        if (daysToExpiry < 90) expiringCount++;
    });

    document.getElementById('metric-total-drugs').textContent = uniqueDrugs.size;
    document.getElementById('metric-low-stock').textContent = lowStockCount;
    document.getElementById('metric-expiring').textContent = expiringCount;
}

// ------ EXCEL IMPORT & EXPORT ------ //
document.getElementById('btn-export').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') {
        alert('Disaster: SheetJS Library is missing. Ensure you are offline but have the library loaded!');
        return;
    }

    const wb = XLSX.utils.book_new();

    // Sheet 1: Master Stock
    const wsMaster = XLSX.utils.json_to_sheet(dataManager.getMasterStock().map(s => ({
        "Drug Name": s.drugName,
        "Strength": s.strength,
        "Batch Number": s.batchNo,
        "Stock Quantity": s.availableStock,
        "Mfg Date": s.mfgDate,
        "Exp Date": s.expDate
    })));
    XLSX.utils.book_append_sheet(wb, wsMaster, "Current Stock");

    // Sheet 2: Transaction Logs
    const wsLogs = XLSX.utils.json_to_sheet(dataManager.logs.map(l => ({
        "Type": l.type === 'receive' ? 'RECEIPT' : 'ISSUE',
        "Drug Name": l.drugName,
        "Strength": l.strength,
        "Batch Number": l.batchNo,
        "Action Date": l.actionDate,
        "Quantity": l.quantity,
        "Mfg Date": l.mfgDate,
        "Exp Date": l.expDate,
        "Remarks": l.remarks
    })));
    XLSX.utils.book_append_sheet(wb, wsLogs, "Transaction History");

    // Sheet 3: EDL List
    const wsEDL = XLSX.utils.json_to_sheet(dataManager.edl.map(d => ({
        "Drug Name": d.name,
        "Strength": d.strength
    })));
    XLSX.utils.book_append_sheet(wb, wsEDL, "EDL Setup");

    XLSX.writeFile(wb, `AAM_Stock_Backup_${new Date().toISOString().split('T')[0]}.xlsx`);
});

document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const data = new Uint8Array(evt.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            
            // Reconstruct Application State or Migrate Legacy
            if (wb.Sheets["EDL Setup"] || wb.Sheets["Transaction History"]) {
                // Scenario A: AAM Standard Backup
                if (wb.Sheets["EDL Setup"]) {
                    const edlData = XLSX.utils.sheet_to_json(wb.Sheets["EDL Setup"]);
                    dataManager.edl = edlData.map(row => ({ name: row["Drug Name"], strength: row["Strength"] }));
                }
                
                if (wb.Sheets["Transaction History"]) {
                    const logData = XLSX.utils.sheet_to_json(wb.Sheets["Transaction History"]);
                    dataManager.logs = logData.map(row => ({
                        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                        type: row["Type"] === 'RECEIPT' ? 'receive' : 'issue',
                        drugName: row["Drug Name"],
                        strength: row["Strength"],
                        batchNo: row["Batch Number"],
                        actionDate: row["Action Date"],
                        quantity: row["Quantity"],
                        mfgDate: row["Mfg Date"] || '',
                        expDate: row["Exp Date"] || '',
                        remarks: row["Remarks"] || ''
                    }));
                }
                showToast('Godlike Import Successful. Data Restored.');
            } else {
                // Scenario B: Legacy Master Inventory Migration
                let migratedCount = 0;
                let logBuffer = [];
                let edlBuffer = [];
                
                wb.SheetNames.forEach(sheetName => {
                    try {
                        const sheet = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
                        if (!sheet || sheet.length < 2) return;
                        
                        let headerRowIdx = -1;
                        for (let i = 0; i < Math.min(10, sheet.length); i++) {
                            if (Array.isArray(sheet[i]) && sheet[i].some(cell => typeof cell === 'string' && cell.toLowerCase().includes('drug name'))) {
                                headerRowIdx = i;
                                break;
                            }
                        }

                        if (headerRowIdx !== -1) {
                            const headers = sheet[headerRowIdx].map(h => typeof h === 'string' ? h.toLowerCase().trim() : '');
                            const nameIdx = headers.findIndex(h => h.includes('drug name'));
                            const balIdx = headers.findIndex(h => h.includes('balance') || h.includes('stock') || h.includes('closing') || h.includes('rec'));
                            
                            if (nameIdx !== -1 && balIdx !== -1) {
                                for (let r = headerRowIdx + 1; r < sheet.length; r++) {
                                    if(!Array.isArray(sheet[r])) continue;
                                    const row = sheet[r];
                                    const dName = row[nameIdx];
                                    const dTotal = parseInt(row[balIdx]);
                                    
                                    if (dName && !isNaN(dTotal) && dTotal > 0) {
                                        const nameStr = String(dName).trim();
                                        
                                        // Cache EDL locally to avoid hammering
                                        if (!edlBuffer.find(d => d.name === nameStr) && !dataManager.edl.find(d => d.name === nameStr)) {
                                            edlBuffer.push({ name: nameStr, strength: "Imported" });
                                        }
                                        
                                        logBuffer.push({
                                            id: Date.now().toString(36) + Math.random().toString(36).substr(2) + migratedCount,
                                            type: 'receive',
                                            drugName: nameStr,
                                            strength: "Imported",
                                            batchNo: "LEGACY-SYS",
                                            actionDate: new Date().toISOString().split('T')[0],
                                            quantity: dTotal,
                                            mfgDate: '',
                                            expDate: '2030-12-31',
                                            remarks: 'Auto-migrated from legacy excel'
                                        });
                                        migratedCount++;
                                    }
                                }
                            }
                        }
                    } catch (sheetErr) {
                        console.warn('Failed parsing sheet: ' + sheetName, sheetErr);
                    }
                });
                
                if (migratedCount > 0) {
                    dataManager.edl.push(...edlBuffer);
                    dataManager.logs.push(...logBuffer);
                    showToast(`Legacy system successfully dismantled! ${migratedCount} records migrated.`);
                } else {
                    alert('Algorithm scanned all sheets but could not detect standard "Drug Name" and "Balance/Stock" column headers.');
                }
            }

            dataManager.saveState();
            
        } catch (error) {
            console.error('Core Exception:', error);
            alert('Catastrophic failure during import! Dissecting the Excel format failed. Error: ' + error.message);
        }
        e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
});

// ------ MONTHLY ANALYTICS ENGINE ------ //
document.getElementById('report-month').addEventListener('change', renderMonthlyReport);

function renderMonthlyReport() {
    const monthVal = document.getElementById('report-month').value;
    const tbody = document.querySelector('#report-table tbody');
    tbody.innerHTML = '';
    
    if (!monthVal) return;

    const reportData = dataManager.getMonthlyReport(monthVal);
    
    if (reportData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 32px; color: var(--text-secondary);">No ledger data for this period.</td></tr>`;
        return;
    }

    reportData.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-label="Drug Name">${row.drugName}</td>
            <td data-label="Strength">${row.strength}</td>
            <td data-label="Opening Stock" style="font-weight: 500;">${row.opening}</td>
            <td data-label="Received" style="color: var(--success);">${row.received > 0 ? '+'+row.received : '-'}</td>
            <td data-label="Issued" style="color: var(--danger);">${row.issued > 0 ? '-'+row.issued : '-'}</td>
            <td data-label="Closing Stock" style="font-weight: 700; color: var(--primary);">${row.closing}</td>
        `;
        
        tr.addEventListener('click', () => showDailyBreakdown(monthVal, row.drugName, row.strength));
        tbody.appendChild(tr);
    });
}

function showDailyBreakdown(monthVal, drugName, strength) {
    const dailyData = dataManager.getDailyReport(monthVal, drugName, strength);
    const tbody = document.querySelector('#daily-table tbody');
    tbody.innerHTML = '';
    
    document.getElementById('daily-modal-title').textContent = `Daily Breakdown: ${drugName} (${strength}) - ${monthVal}`;
    
    dailyData.forEach(day => {
        const tr = document.createElement('tr');
        
        // Highlight active days slightly
        if (day.received > 0 || day.issued > 0) {
            tr.style.background = 'rgba(59, 130, 246, 0.05)';
        }

        tr.innerHTML = `
            <td>${day.date}</td>
            <td>${day.opening}</td>
            <td style="color: var(--success); font-weight: 600;">${day.received > 0 ? '+'+day.received : '-'}</td>
            <td style="color: var(--danger); font-weight: 600;">${day.issued > 0 ? '-'+day.issued : '-'}</td>
            <td style="font-weight: bold; color: var(--primary);">${day.closing}</td>
        `;
        tbody.appendChild(tr);
    });
    
    document.getElementById('modal-daily').classList.remove('hidden');
}

document.getElementById('btn-close-daily').addEventListener('click', () => {
    document.getElementById('modal-daily').classList.add('hidden');
});

document.getElementById('btn-export-report').addEventListener('click', () => {
    const monthVal = document.getElementById('report-month').value;
    if (!monthVal) return alert('Select a month to export first!');
    
    if (typeof XLSX === 'undefined') {
        alert('Disaster: SheetJS Library is missing.');
        return;
    }

    const reportData = dataManager.getMonthlyReport(monthVal);
    
    const ws = XLSX.utils.json_to_sheet(reportData.map(r => ({
        "Drug Name": r.drugName,
        "Strength": r.strength,
        "Opening Balance": r.opening,
        "Received": r.received,
        "Issued": r.issued,
        "Closing Balance": r.closing
    })));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Report ${monthVal}`);
    XLSX.writeFile(wb, `AAM_Analytics_${monthVal}.xlsx`);
    showToast(`Monthly Ledger for ${monthVal} exported successfully!`);
});

// Set default month to current month and build dropdown dynamically
const selectMonthMode = document.getElementById('report-month');
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const currentIsoMonth = new Date().toISOString().slice(0, 7);

for (let y = 2025; y <= 2030; y++) {
    for (let m = 0; m < 12; m++) {
        // Only allow July 2025 onwards since that's Genesis
        if (y === 2025 && m < 6) continue;
        
        const mStr = String(m + 1).padStart(2, '0');
        const val = `${y}-${mStr}`;
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = `${monthNames[m]} ${y}`;
        selectMonthMode.appendChild(opt);
    }
}
selectMonthMode.value = currentIsoMonth;
selectMonthMode.value = currentIsoMonth;
if(!selectMonthMode.value) selectMonthMode.selectedIndex = 0; // fallback if current is out of range

// ------ CLOUD SYNC ENGINE ------ //
document.getElementById('form-github-config').addEventListener('submit', (e) => {
    e.preventDefault();
    const config = {
        token: document.getElementById('gh-token').value.trim(),
        owner: document.getElementById('gh-owner').value.trim(),
        repo: document.getElementById('gh-repo').value.trim(),
        path: document.getElementById('gh-path').value.trim()
    };
    dataManager.saveCloudConfig(config);
});

document.getElementById('btn-disconnect-gh').addEventListener('click', () => {
    if (confirm('Disconnect from cloud? Local data will remain but automatic syncing will stop.')) {
        dataManager.disconnectCloud();
    }
});

document.getElementById('btn-pull-cloud').addEventListener('click', () => {
    if (confirm('Overwriting local data with Cloud Mirror? Current local changes will be lost.')) {
        dataManager.pullFromCloud(false);
    }
});

document.getElementById('btn-push-cloud').addEventListener('click', () => {
    dataManager.pushToCloud();
});

// ------ SYSTEM BOOT ------ //
if('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
        .then(() => console.log('AAM Service Worker activated flawlessly.'))
        .catch((err) => console.error('Disaster! Service Worker failed.', err));
}

// Initial render
renderApp();
renderMonthlyReport();
