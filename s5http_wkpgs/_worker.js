const pyip = ['[2a00:1098:2b::1:6815:5881]','pyip.ygkkk.dpdns.org']; 
const token = '52135213';

const fakePage = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Service Dashboard</title>
    <style>
        body { 
            margin: 0; 
            padding: 0; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            background-color: #f5f5f7; 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #1d1d1f;
        }
        .container { 
            text-align: center; 
            animation: fadeIn 1.2s ease-out;
        }
        .logo {
            width: 64px;
            height: 64px;
            margin-bottom: 24px;
            opacity: 0.8;
        }
        h1 { 
            font-size: 24px; 
            font-weight: 500; 
            letter-spacing: -0.015em;
            margin-bottom: 8px;
        }
        p { 
            font-size: 17px; 
            color: #86868b; 
            font-weight: 400;
        }
        .dot-loader {
            margin-top: 40px;
            display: flex;
            justify-content: center;
            gap: 8px;
        }
        .dot {
            width: 6px;
            height: 6px;
            background-color: #d2d2d7;
            border-radius: 50%;
            animation: pulse 1.5s infinite ease-in-out;
        }
        .dot:nth-child(2) { animation-delay: 0.3s; }
        .dot:nth-child(3) { animation-delay: 0.6s; }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 1; }
        }
    </style>
</head>
<body>
    <div class="container">
        <svg class="logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="48" stroke="#d2d2d7" stroke-width="2"/>
            <path d="M30 50L45 65L70 35" stroke="#d2d2d7" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h1>系统连接已就绪</h1>
        <p>正在同步云端配置，请稍后...</p>
        <div class="dot-loader">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
        </div>
    </div>
</body>
</html>
`;

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const encoder = new TextEncoder();
import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      
      // 保持原有逻辑：普通访问返回苹果风格伪装页
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response(fakePage, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 代理逻辑（核心功能，绝对未改动）
      if (token && request.headers.get('Sec-WebSocket-Protocol') !== token) {
        return new Response('Unauthorized', { status: 401 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      handleSession(server).catch(() => safeCloseWebSocket(server));
      const responseInit = {
        status: 101,
        webSocket: client
      };
      if (token) {
        responseInit.headers = { 'Sec-WebSocket-Protocol': token };
      }
      return new Response(null, responseInit);

    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  },
};

// --- 以下 handleSession 及辅助函数完全保留原样 ---
async function handleSession(webSocket) {
  let remoteSocket, remoteWriter, remoteReader;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    try { remoteWriter?.releaseLock(); } catch {}
    try { remoteReader?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}
    remoteWriter = remoteReader = remoteSocket = null;
    safeCloseWebSocket(webSocket);
  };
  const pumpRemoteToWebSocket = async () => {
    try {
      while (!isClosed && remoteReader) {
        const { done, value } = await remoteReader.read();
        if (done) break;
        if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
        if (value?.byteLength > 0) webSocket.send(value);
      }
    } catch {}
    if (!isClosed) {
      try { webSocket.send('CLOSE'); } catch {}
      cleanup();
    }
  };
  const parseAddress = (addr) => {
    if (addr[0] === '[') {
      const end = addr.indexOf(']');
      return { host: addr.substring(1, end), port: parseInt(addr.substring(end + 2), 10) };
    }
    const sep = addr.lastIndexOf(':');
    return { host: addr.substring(0, sep), port: parseInt(addr.substring(sep + 1), 10) };
  };
  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') || msg.includes('cannot connect') || msg.includes('cloudflare');
  };
  const parseClientPyip = (s) => {
    if (!s) return null;
    const trimmed = String(s).trim();
    if (!trimmed.toUpperCase().startsWith('PYIP=')) return null;
    const val = trimmed.substring(5).trim();
    if (!val) return null;
    const arr = val.split(',').map(x => x.trim()).filter(Boolean);
    return arr.length ? arr : null;
  };
  const connectToRemote = async (targetAddr, firstFrameData, clientPyip) => {
    const { host, port } = parseAddress(targetAddr);
    const pyipList = (Array.isArray(clientPyip) && clientPyip.length) ? clientPyip : pyip;
    const attempts = [null, ...pyipList];
    for (let i = 0; i < attempts.length; i++) {
      try {
        remoteSocket = connect({ hostname: attempts[i] || host, port });
        if (remoteSocket.opened) await remoteSocket.opened;
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();
        if (firstFrameData) { await remoteWriter.write(encoder.encode(firstFrameData)); }
        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket();
        return;
      } catch (err) {
        try { remoteWriter?.releaseLock(); } catch {}
        try { remoteReader?.releaseLock(); } catch {}
        try { remoteSocket?.close(); } catch {}
        remoteWriter = remoteReader = remoteSocket = null;
        if (!isCFError(err) || i === attempts.length - 1) { throw err; }
      }
    }
  };
  webSocket.addEventListener('message', async (event) => {
    if (isClosed) return;
    try {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.startsWith('CONNECT:')) {
          const parts = data.substring(8).split('|');
          const targetAddr = parts[0] || '';
          const firstFrameData = parts[1] ?? '';
          const clientPyip = parseClientPyip(parts[2]);
          await connectToRemote(targetAddr, firstFrameData, clientPyip);
        }
        else if (data.startsWith('DATA:')) {
          if (remoteWriter) { await remoteWriter.write(encoder.encode(data.substring(5))); }
        }
        else if (data === 'CLOSE') { cleanup(); }
      }
      else if (data instanceof ArrayBuffer && remoteWriter) {
        await remoteWriter.write(new Uint8Array(data));
      }
    } catch (err) {
      try { webSocket.send('ERROR:' + err.message); } catch {}
      cleanup();
    }
  });
  webSocket.addEventListener('close', cleanup);
  webSocket.addEventListener('error', cleanup);
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}
