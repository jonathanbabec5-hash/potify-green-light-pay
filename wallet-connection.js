/* Green Light Pay: injected Phantom/Solflare connection and read-only balances.
 * No wallet signature, transfer, swap, funding or payment is requested here.
 * Balances come from the public Solana mainnet RPC and can be unavailable.
 */
(() => {
  'use strict';
  const RPC = 'https://api.mainnet.solana.com';
  const MINTS = {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    POTIFY: 'GWdHGomLjqofUSrj3TEhinr2UaRJMzJ5o7MRZLaFpump',
  };
  const TOKEN_PROGRAMS = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ]);
  const hub = document.getElementById('live-wallet-hub');
  const root = document.getElementById('live-wallet-dialog');
  if (!hub || !root) return;
  let current = null;
  let generation = 0;
  let modalOpen = false;
  let rpcId = 0;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short = s => `${s.slice(0, 5)}…${s.slice(-5)}`;
  const mobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');

  // Base58 string must decode to exactly 32 bytes, not just look plausible.
  function validKey(value) {
    if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const char of value) {
      const digit = alphabet.indexOf(char);
      if (digit < 0) return false;
      n = n * 58n + BigInt(digit);
    }
    let bytes = 0;
    while (n > 0n) { bytes++; n >>= 8n; }
    for (const char of value) { if (char !== '1') break; bytes++; }
    return bytes === 32;
  }
  function providerFor(kind) {
    if (kind === 'Phantom') {
      const p = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
      return p?.isPhantom && typeof p.connect === 'function' ? p : null;
    }
    const p = window.solflare || (window.solana?.isSolflare ? window.solana : null);
    return p?.isSolflare && typeof p.connect === 'function' ? p : null;
  }
  function baseUrl() {
    if (location.protocol !== 'https:') return null;
    // Do not carry any query values or URL fragments into wallet redirects.
    return location.origin + location.pathname;
  }
  function browseUrl(kind) {
    const url = baseUrl();
    if (!url) return null;
    const route = kind === 'Phantom' ? 'https://phantom.com/ul/browse/' : 'https://solflare.com/ul/v1/browse/';
    return route + encodeURIComponent(url) + '?ref=' + encodeURIComponent(location.origin);
  }
  function displayAmount(raw, decimals) {
    const n = BigInt(raw);
    const scale = 10n ** BigInt(decimals);
    const whole = (n / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const fraction = decimals ? (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
    return whole + (fraction ? '.' + fraction : '');
  }
  async function rpc(method, params) {
    const id = ++rpcId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(RPC, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id,method,params}), signal:controller.signal,
        cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer',
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const json = await response.json();
      if (json.id !== id || json.error || !json.result) throw new Error('RPC response invalid');
      return json.result;
    } finally { clearTimeout(timer); }
  }
  async function solBalance(address) {
    const result = await rpc('getBalance', [address, {commitment:'confirmed'}]);
    if (!Number.isSafeInteger(result.value) || result.value < 0) throw new Error('SOL balance out of range');
    return displayAmount(BigInt(result.value), 9) + ' SOL';
  }
  async function tokenBalance(address, mint, symbol) {
    const result = await rpc('getTokenAccountsByOwner', [address, {mint}, {encoding:'jsonParsed',commitment:'confirmed'}]);
    if (!Array.isArray(result.value)) throw new Error('Token accounts unavailable');
    let total = 0n, decimals = null;
    for (const entry of result.value) {
      const account = entry?.account;
      const info = account?.data?.parsed?.info;
      const amount = info?.tokenAmount;
      if (!TOKEN_PROGRAMS.has(account?.owner) || info?.owner !== address || info?.mint !== mint ||
          !amount || typeof amount.amount !== 'string' || !/^[0-9]+$/.test(amount.amount) || !Number.isInteger(amount.decimals) ||
          amount.decimals < 0 || amount.decimals > 18 || (decimals !== null && decimals !== amount.decimals)) {
        throw new Error('Token account validation failed');
      }
      decimals = amount.decimals;
      total += BigInt(amount.amount);
    }
    return (decimals === null ? '0' : displayAmount(total, decimals)) + ' ' + symbol;
  }
  function clearListeners(connection) {
    if (!connection?.provider) return;
    const remove = connection.provider.removeListener || connection.provider.off;
    if (typeof remove === 'function') {
      remove.call(connection.provider, 'accountChanged', connection.onAccount);
      remove.call(connection.provider, 'disconnect', connection.onDisconnect);
    }
  }
  function reset() {
    generation++;
    clearListeners(current);
    current = null;
    render();
  }
  async function refresh() {
    if (!current) return;
    const ticket = ++generation, connection = current, address = current.address;
    current.loading = true;
    current.balances = {SOL:'Loading…',USDC:'Loading…',POTIFY:'Loading…'};
    current.message = '';
    render();
    const result = await Promise.allSettled([
      solBalance(address), tokenBalance(address, MINTS.USDC, 'USDC'), tokenBalance(address, MINTS.POTIFY, '$POTIFY'),
    ]);
    if (generation !== ticket || current !== connection || current.address !== address) return;
    const labels = ['SOL','USDC','POTIFY'];
    labels.forEach((label, i) => { current.balances[label] = result[i].status === 'fulfilled' ? result[i].value : 'Unavailable'; });
    current.loading = false;
    if (result.some(r => r.status === 'rejected')) current.message = 'One or more balances could not load. The public Solana service may be busy; try refresh.';
    render();
  }
  function modalMessage(text) {
    const node = document.getElementById('wallet-message');
    if (node) node.textContent = text;
  }
  async function connect(kind) {
    if (current?.connecting) return;
    const p = providerFor(kind);
    if (!p) {
      const url = browseUrl(kind);
      if (mobile() && url) {
        // This opens the current HTTPS app inside the chosen wallet; it does not
        // request a signature or carry any key material in the URL.
        window.location.assign(url);
        return;
      }
      modalMessage(mobile() ? 'Open this app from an HTTPS link first, then use your wallet’s browser.' : `${kind} was not detected. Install or unlock it and try again.`);
      return;
    }
    if (current) {
      modalMessage('Disconnect the current wallet before connecting a different wallet.');
      return;
    }
    const ticket = ++generation;
    current = {kind,provider:p,connecting:true,address:null,loading:false,balances:{}};
    render();
    try {
      const result = await p.connect();
      if (ticket !== generation || current?.provider !== p) return;
      const publicKey = result?.publicKey || p.publicKey;
      const address = publicKey?.toString?.();
      if (!validKey(address)) throw new Error('Wallet returned an invalid public address');
      const connection = current;
      connection.address = address;
      connection.connecting = false;
      connection.onAccount = key => {
        if (current !== connection) return;
        const next = key?.toString?.();
        if (!next) { reset(); return; }
        if (!validKey(next)) { reset(); return; }
        connection.address = next;
        refresh();
      };
      connection.onDisconnect = () => { if (current === connection) reset(); };
      if (typeof p.on === 'function') {
        p.on('accountChanged', connection.onAccount);
        p.on('disconnect', connection.onDisconnect);
      }
      await refresh();
    } catch (error) {
      if (ticket !== generation) return;
      reset();
      modalOpen = true;
      render();
      modalMessage(error?.code === 4001 ? 'Connection was declined in your wallet.' : 'The wallet could not connect. Unlock it and try again.');
    }
  }
  async function disconnect() {
    const old = current;
    reset();
    // The wallet owns its own authorization; request disconnection but clear
    // our local state even if the provider has already disconnected.
    try { if (old?.provider && typeof old.provider.disconnect === 'function') await old.provider.disconnect(); } catch (_) {}
  }
  function render() {
    const connected = current && !current.connecting && current.address;
    hub.innerHTML = connected
      ? `<button class="live-wallet-bar" data-live-action="details" aria-label="View connected wallet"><span><strong>LIVE WALLET</strong> ${esc(current.kind)} · ${esc(short(current.address))}</span><b>View</b></button>`
      : `<button class="live-wallet-bar" data-live-action="details"><span><strong>LIVE WALLET</strong> ${current?.connecting ? 'Connecting…' : 'Connect Phantom or Solflare'}</span><b>${current?.connecting ? '…' : 'Connect'}</b></button>`;
    if (!modalOpen) { root.innerHTML = ''; return; }
    let content;
    if (current?.connecting) {
      content = '<p class="caption">Approve the connection in your wallet. No transaction or signature is requested.</p><p id="wallet-message" class="error" role="status"></p>';
    } else if (!connected) {
      content = `<p class="caption">Connect to view your public address and real Solana balances. Your wallet asks for permission; no transaction or signature is requested.</p><div class="space"></div><button class="button wide" data-live-action="connect-phantom">Connect Phantom</button><div class="space"></div><button class="button secondary wide" data-live-action="connect-solflare">Connect Solflare</button><p id="wallet-message" class="error" role="status"></p><p class="footer-note">On iPhone, use the link to open this page inside the wallet app. Your public address is sent to Solana’s public RPC to load balances. The payment, shop, and funding screens remain demonstrations.</p>`;
    } else {
      content = `<p class="caption">${esc(current.kind)} · Solana mainnet</p><div class="space"></div><div class="subcard"><div class="eyebrow">Public wallet address</div><p class="code">${esc(current.address)}</p></div><div class="space"></div><div class="card">${['SOL','USDC','POTIFY'].map(k=>`<div class="asset-item"><b>${k==='POTIFY'?'$POTIFY':k}</b><span>${esc(current.balances[k]||'Loading…')}</span></div>`).join('')}</div><p id="wallet-message" class="error" role="status">${esc(current.message||'')}</p><p class="footer-note">Real on-chain balances only. Demo cash and demo purchases below are separate and cannot move money.</p><div class="actions" style="grid-template-columns:1fr 1fr"><button class="button secondary" data-live-action="refresh" ${current.loading?'disabled':''}>Refresh</button><button class="button secondary" data-live-action="copy">Copy address</button></div><div class="space"></div><button class="button ghost wide" data-live-action="disconnect">Disconnect wallet</button>`;
    }
    root.innerHTML = `<div class="modal-backdrop wallet-overlay" data-live-action="backdrop"><section class="sheet" role="dialog" aria-modal="true" aria-label="Live wallet"><div class="line"></div><div class="between"><h2>Live wallet</h2><button class="round" data-live-action="close" aria-label="Close wallet dialog">×</button></div>${content}</section></div>`;
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-live-action]');
    if (!target) return;
    const action = target.dataset.liveAction;
    if (action === 'backdrop' && event.target !== target) return;
    if (action === 'details') { modalOpen = true; render(); }
    if (action === 'close' || action === 'backdrop') { modalOpen = false; render(); }
    if (action === 'connect-phantom') connect('Phantom');
    if (action === 'connect-solflare') connect('Solflare');
    if (action === 'refresh') refresh();
    if (action === 'disconnect') disconnect();
    if (action === 'copy' && current?.address) {
      navigator.clipboard?.writeText(current.address).then(() => modalMessage('Address copied.'), () => modalMessage('Unable to copy; select the public address above.'));
      if (!navigator.clipboard) modalMessage('Unable to copy; select the public address above.');
    }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && modalOpen) { modalOpen = false; render(); } });
  render();
})();
