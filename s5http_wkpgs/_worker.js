const pyip = ['[2a00:1098:2b::1:6815:5881]','pyip.ygkkk.dpdns.org']; 
const token = '52135213';

// --- 伪装网页 HTML 代码 ---
const fakePage = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>站点搜索 - 引导页</title>
    <style>
        body { background: #f5f5f7; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .search-box { background: white; padding: 20px; border-radius: 50px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 80%; max-width: 500px; display: flex; }
        input { border: none; outline: none; flex: 1; font-size: 16px; padding-left: 10px; }
        button { background: #0071e3; color: white; border: none; padding: 8px 20px; border-radius: 20px; cursor: pointer; }
        .footer { margin-top: 20px; color: #86868b; font-size: 12px; }
    </style>
</head>
<body>
    <h2>资源搜索</h2>
    <div class="search-box">
        <input type="text" placeholder="输入关键词搜索...">
        <button>搜索</button>
    </div>
    <div class="footer">© 2026 站点服务中心 - 资源索引中</div>
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
      
      // 这里是原本判断显示“恭喜...”的地方
      // 现在的逻辑：如果不是 WebSocket 请求，一律返回上面的伪装 HTML 内容
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response(fakePage, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 核心代理逻辑开始（完全保留，未做改动）
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

// --- 以下所有 handleSession 及辅助函数均未做任何删改，与原代码完全一致 ---
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
      return {
        host: addr.substring(1, end),
        port: parseInt(addr.substring(end + 2), 10)
      };
    }
    const sep = addr.lastIndexOf(':');
    return {
      host: addr.substring(0, sep),
      port: parseInt(addr.substring(sep + 1), 10)
    };
  };
  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('cloudflare');
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
        remoteSocket = connect({
          hostname: attempts[i] || host,
          port
        });
        if (remoteSocket.opened) await remoteSocket.opened;
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();
        if (firstFrameData) {
          await remoteWriter.write(encoder.encode(firstFrameData));
        }
        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket();
        return;
      } catch (err) {
        try { remoteWriter?.releaseLock(); } catch {}
        try { remoteReader?.releaseLock(); } catch {}
        try { remoteSocket?.close(); } catch {}
        remoteWriter = remoteReader = remoteSocket = null;
        if (!isCFError(err) || i === attempts.length - 1) {
          throw err;
        }
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
          if (remoteWriter) {
            await remoteWriter.write(encoder.encode(data.substring(5)));
          }
        }
        else if (data === 'CLOSE') {
          cleanup();
        }
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
    if (ws.readyState === WS_READY_STATE_OPEN ||
        ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}
