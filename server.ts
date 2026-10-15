import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Guardias de Proceso 24/7: Evitan caídas inesperadas del proceso Node.js ante errores de red
process.on('uncaughtException', (err) => {
  console.error('[Guardia 24/7] Excepción no capturada interceptada con éxito:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Guardia 24/7] Rechazo asíncrono no controlado interceptado con éxito:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());

// Definición de las 13 comisiones oficiales
const COMMISSIONS_DATA = [
  { id: "com_org", name: "Organización y coordinación", maxQuota: 5 },
  { id: "com_insc", name: "Comisión inscripciones", maxQuota: 5 },
  { id: "com_dors", name: "Comisión dorsales", maxQuota: 3 },
  { id: "com_med", name: "Comisión de medallas finisher", maxQuota: 3 },
  { id: "com_hidr", name: "Comisión puntos de hidratación", maxQuota: 14 },
  { id: "com_part", name: "Comisión partida", maxQuota: 5 },
  { id: "com_lleg", name: "Comisión llegada", maxQuota: 5 },
  { id: "com_prem", name: "Comisión premiación", maxQuota: 5 },
  { id: "com_seg", name: "Comisión seguridad y tránsito vehicular", maxQuota: 20 },
  { id: "com_cron", name: "Comisión registro y cronómetro", maxQuota: 8 },
  { id: "com_ruta", name: "Comisión controles durante la ruta", maxQuota: 16 },
  { id: "com_ausp", name: "Comisión auspiciadores", maxQuota: 8 },
  { id: "com_econ", name: "Comisión económica", maxQuota: 2 }
];

export interface Officer {
  id: string;
  rank: string;
  fullName: string;
  commissionId: string;
  commissionName: string;
  role: 'ADMINISTRADOR' | 'OFICIAL';
  timestamp: string;
  deviceType?: 'Móvil' | 'PC' | string;
}

// Estado autoritativo centralizado en tiempo real (Soporta múltiples registros de usuarios)
const state = {
  adminOfficer: null as Officer | null,
  registeredOfficers: [] as Officer[],
  quotas: {} as Record<string, number>,
  assignedOfficers: {} as Record<string, Officer[]>
};

// Inicializar cupos y colecciones
COMMISSIONS_DATA.forEach(c => {
  state.quotas[c.id] = c.maxQuota;
  state.assignedOfficers[c.id] = [];
});

// Persistencia en disco para garantizar retención ante reinicios de servidor
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'militar_state.json');

function saveServerState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const toSave = {
      adminOfficer: state.adminOfficer,
      registeredOfficers: state.registeredOfficers,
      quotas: state.quotas,
      assignedOfficers: state.assignedOfficers,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error guardando estado en disco:', err);
  }
}

function loadServerState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (saved.quotas) {
          Object.keys(saved.quotas).forEach(id => {
            state.quotas[id] = saved.quotas[id];
          });
        }
        if (Array.isArray(saved.registeredOfficers)) {
          state.registeredOfficers = saved.registeredOfficers;
          COMMISSIONS_DATA.forEach(c => {
            state.assignedOfficers[c.id] = [];
          });
          state.registeredOfficers.forEach((ofc: Officer) => {
            if (ofc && ofc.commissionId) {
              if (!state.assignedOfficers[ofc.commissionId]) {
                state.assignedOfficers[ofc.commissionId] = [];
              }
              state.assignedOfficers[ofc.commissionId].push(ofc);
            }
          });
        } else if (saved.assignedOfficers) {
          state.assignedOfficers = saved.assignedOfficers;
          state.registeredOfficers = [];
          Object.values(state.assignedOfficers).forEach(list => {
            if (Array.isArray(list)) state.registeredOfficers.push(...list);
          });
        }
        if (saved.adminOfficer) {
          state.adminOfficer = saved.adminOfficer;
        } else if (state.registeredOfficers.length > 0) {
          state.adminOfficer = state.registeredOfficers[0];
        }
        console.log(`Estado restaurado con éxito: ${state.registeredOfficers.length} oficiales registrados.`);
      }
    }
  } catch (err) {
    console.error('Error cargando estado desde disco:', err);
  }
}

loadServerState();

// Persistencia en disco del Escudo, Fondos y Configuración Visual
const THEME_FILE = path.join(DATA_DIR, 'militar_theme.json');
let serverTheme: any = null;

function saveServerTheme(themeData: any) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(THEME_FILE, JSON.stringify(themeData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error guardando configuración de tema en disco:', err);
  }
}

function loadServerTheme() {
  try {
    if (fs.existsSync(THEME_FILE)) {
      const raw = fs.readFileSync(THEME_FILE, 'utf-8');
      serverTheme = JSON.parse(raw);
      console.log('Tema y personalización visual recuperados del servidor con éxito.');
    }
  } catch (err) {
    console.error('Error cargando tema desde disco:', err);
  }
}

loadServerTheme();

// Control de clientes WebSocket y detección de dispositivos (Móvil vs PC)
interface ClientInfo {
  ws: WebSocket;
  id: string;
  deviceType: 'Móvil' | 'PC';
  isAlive: boolean;
  connectedAt: number;
}

const clientsMap = new Map<WebSocket, ClientInfo>();

function broadcast(event: string, payload: any) {
  const message = JSON.stringify({ event, payload, timestamp: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (e) {
        console.warn('Error enviando mensaje a cliente:', e);
      }
    }
  });
}

function getPresenceStats() {
  let mobileCount = 0;
  let pcCount = 0;

  clientsMap.forEach(info => {
    if (info.deviceType === 'Móvil') {
      mobileCount++;
    } else {
      pcCount++;
    }
  });

  const total = wss.clients.size;
  if (mobileCount === 0 && pcCount === 0 && total > 0) {
    pcCount = total;
  }

  return {
    onlineCount: Math.max(1, total),
    mobileCount,
    pcCount
  };
}

function broadcastPresence() {
  const stats = getPresenceStats();
  broadcast('presence:update', stats);
}

// Registro de Oficiales en Tiempo Real (soporta múltiples usuarios en Móvil o PC)
function registerOfficerHandler(payload: {
  id?: string;
  rank: string;
  fullName: string;
  commissionId: string;
  role?: 'ADMINISTRADOR' | 'OFICIAL';
  deviceType?: 'Móvil' | 'PC' | string;
}) {
  const { id, rank, fullName, commissionId, role, deviceType } = payload;

  if (!rank || !fullName || !commissionId) {
    return { success: false, message: 'Faltan campos obligatorios para el registro.' };
  }

  if (state.quotas[commissionId] === undefined || state.quotas[commissionId] <= 0) {
    return { success: false, message: 'La comisión seleccionada no tiene cupos disponibles.' };
  }

  const com = COMMISSIONS_DATA.find(c => c.id === commissionId);
  const commissionName = com ? com.name : commissionId;

  // Descontar cupo
  state.quotas[commissionId] -= 1;

  const officerRole = role || (state.registeredOfficers.length === 0 ? 'ADMINISTRADOR' : 'OFICIAL');
  const newOfficer: Officer = {
    id: id || 'ofc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    rank: rank.trim(),
    fullName: (fullName || '').trim().toUpperCase(),
    commissionId,
    commissionName,
    role: officerRole,
    deviceType: deviceType || 'Dispositivo',
    timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  if (!state.assignedOfficers[commissionId]) {
    state.assignedOfficers[commissionId] = [];
  }
  state.assignedOfficers[commissionId].push(newOfficer);
  state.registeredOfficers.push(newOfficer);

  if (!state.adminOfficer || newOfficer.role === 'ADMINISTRADOR') {
    state.adminOfficer = newOfficer;
  }

  saveServerState();

  const responsePayload = {
    officer: newOfficer,
    adminOfficer: state.adminOfficer,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers,
    registeredOfficers: state.registeredOfficers
  };

  // Emitir evento principal de registro y compatibilidad admin
  broadcast('officer:registered', responsePayload);
  broadcast('admin:registered', responsePayload);
  broadcast('sync:state', {
    ...responsePayload,
    ...getPresenceStats()
  });

  return { success: true, ...responsePayload };
}

export interface HandlerResult {
  success: boolean;
  message?: string;
  officer?: Officer;
  adminOfficer?: Officer | null;
  quotas?: Record<string, number>;
  assignedOfficers?: Record<string, Officer[]>;
  registeredOfficers?: Officer[];
  deletedId?: string;
  commissionId?: string;
  newQuota?: number;
}

function updateOfficerHandler(payload: {
  id?: string;
  rank: string;
  fullName: string;
  commissionId: string;
  oldCommissionId?: string;
  deviceType?: string;
}): HandlerResult {
  const { id, rank, fullName, commissionId, oldCommissionId } = payload;

  const targetId = id || (state.adminOfficer ? state.adminOfficer.id : '');
  const officerIdx = state.registeredOfficers.findIndex(o => o.id === targetId);
  if (officerIdx === -1) {
    return { success: false, message: 'No se encontró el oficial a modificar.' };
  }

  const currentOfficer = state.registeredOfficers[officerIdx];
  const prevComId = oldCommissionId || currentOfficer.commissionId;

  // Si cambió de comisión, comprobar cupo y reajustar
  if (prevComId !== commissionId) {
    if (!state.quotas[commissionId] || state.quotas[commissionId] <= 0) {
      return { success: false, message: 'La nueva comisión seleccionada no tiene cupos disponibles.' };
    }
    state.quotas[prevComId] = (state.quotas[prevComId] || 0) + 1;
    state.quotas[commissionId] -= 1;

    if (state.assignedOfficers[prevComId]) {
      state.assignedOfficers[prevComId] = state.assignedOfficers[prevComId].filter(o => o.id !== targetId);
    }
  }

  const com = COMMISSIONS_DATA.find(c => c.id === commissionId);
  const updatedOfficer: Officer = {
    ...currentOfficer,
    rank: rank.trim(),
    fullName: fullName.trim().toUpperCase(),
    commissionId,
    commissionName: com ? com.name : commissionId,
    timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  state.registeredOfficers[officerIdx] = updatedOfficer;

  if (!state.assignedOfficers[commissionId]) {
    state.assignedOfficers[commissionId] = [];
  }
  const assignedIdx = state.assignedOfficers[commissionId].findIndex(o => o.id === targetId);
  if (assignedIdx >= 0) {
    state.assignedOfficers[commissionId][assignedIdx] = updatedOfficer;
  } else {
    state.assignedOfficers[commissionId].push(updatedOfficer);
  }

  if (state.adminOfficer && state.adminOfficer.id === targetId) {
    state.adminOfficer = updatedOfficer;
  }

  saveServerState();

  const responsePayload = {
    officer: updatedOfficer,
    adminOfficer: state.adminOfficer,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers,
    registeredOfficers: state.registeredOfficers
  };

  broadcast('officer:updated', responsePayload);
  broadcast('admin:updated', responsePayload);
  broadcast('sync:state', {
    ...responsePayload,
    ...getPresenceStats()
  });

  return { success: true, ...responsePayload };
}

function updateAdminFallback(payload: any): HandlerResult {
  if (!state.adminOfficer) return { success: false, message: 'No existe registro para modificar.' };
  return updateOfficerHandler({ ...payload, id: state.adminOfficer.id });
}

function deleteOfficerHandler(payload: { id?: string; commissionId?: string }) {
  const { id } = payload;
  let targetId = id;

  if (!targetId && state.adminOfficer) {
    targetId = state.adminOfficer.id;
  }

  if (!targetId) {
    return { success: false, message: 'No se especificó oficial para eliminar.' };
  }

  const officer = state.registeredOfficers.find(o => o.id === targetId);
  if (!officer) {
    return { success: false, message: 'Oficial no encontrado.' };
  }

  const comId = officer.commissionId;
  if (state.quotas[comId] !== undefined) {
    state.quotas[comId] += 1;
  }

  state.registeredOfficers = state.registeredOfficers.filter(o => o.id !== targetId);
  if (state.assignedOfficers[comId]) {
    state.assignedOfficers[comId] = state.assignedOfficers[comId].filter(o => o.id !== targetId);
  }

  if (state.adminOfficer && state.adminOfficer.id === targetId) {
    state.adminOfficer = state.registeredOfficers.length > 0 ? state.registeredOfficers[0] : null;
  }

  saveServerState();

  const responsePayload = {
    deletedId: targetId,
    adminOfficer: state.adminOfficer,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers,
    registeredOfficers: state.registeredOfficers
  };

  broadcast('officer:deleted', responsePayload);
  broadcast('admin:deleted', responsePayload);
  broadcast('sync:state', {
    ...responsePayload,
    ...getPresenceStats()
  });

  return { success: true, ...responsePayload };
}

function updateWindowQuotaHandler(payload: { commissionId: string; newQuota: number }) {
  const { commissionId, newQuota } = payload;
  if (commissionId && typeof newQuota === 'number' && newQuota >= 0) {
    state.quotas[commissionId] = newQuota;
    saveServerState();

    const responsePayload = {
      commissionId,
      newQuota,
      quotas: state.quotas,
      assignedOfficers: state.assignedOfficers,
      registeredOfficers: state.registeredOfficers
    };

    broadcast('window:quota_updated', responsePayload);
    broadcast('sync:state', {
      ...responsePayload,
      adminOfficer: state.adminOfficer,
      ...getPresenceStats()
    });

    return { success: true, ...responsePayload };
  }
  return { success: false, message: 'Cupo o comisión inválidos.' };
}

// Heartbeat para verificar conexiones vivas y limpiar desconexiones en móviles
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    const client = clientsMap.get(ws);
    if (!client) return;
    if (!client.isAlive) {
      clientsMap.delete(ws);
      ws.terminate();
      broadcastPresence();
      return;
    }
    client.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      clientsMap.delete(ws);
      ws.terminate();
      broadcastPresence();
    }
  });
}, 15000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', (ws, req) => {
  // Detección inicial por User-Agent si está disponible
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  const clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

  const clientInfo: ClientInfo = {
    ws,
    id: clientId,
    deviceType: isMobile ? 'Móvil' : 'PC',
    isAlive: true,
    connectedAt: Date.now()
  };

  clientsMap.set(ws, clientInfo);

  ws.on('pong', () => {
    const client = clientsMap.get(ws);
    if (client) client.isAlive = true;
  });

  // Notificar a todos la nueva presencia
  broadcastPresence();

  // Enviar estado íntegro y datos de sincronización al cliente recién conectado
  const presence = getPresenceStats();
  ws.send(JSON.stringify({
    event: 'sync:state',
    payload: {
      adminOfficer: state.adminOfficer,
      registeredOfficers: state.registeredOfficers,
      quotas: state.quotas,
      assignedOfficers: state.assignedOfficers,
      onlineCount: presence.onlineCount,
      mobileCount: presence.mobileCount,
      pcCount: presence.pcCount
    }
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Latido / Keepalive 24/7 de WebSocket
      if (msg.type === 'ping') {
        const client = clientsMap.get(ws);
        if (client) client.isAlive = true;
        ws.send(JSON.stringify({ event: 'pong', uptime: Math.floor(process.uptime()), timestamp: Date.now() }));
        return;
      }

      // Mensaje de saludo/handshake con tipo de dispositivo reportado por el cliente
      if (msg.type === 'hello') {
        const client = clientsMap.get(ws);
        if (client && msg.deviceType) {
          client.deviceType = msg.deviceType === 'Móvil' ? 'Móvil' : 'PC';
          broadcastPresence();
        }
      } else if (msg.type === 'register_officer' || msg.type === 'register_admin') {
        const result = registerOfficerHandler(msg.payload || {});
        if (!result.success) {
          ws.send(JSON.stringify({ event: 'error', message: result.message }));
        }
      } else if (msg.type === 'update_officer' || msg.type === 'update_admin') {
        const result = updateOfficerHandler(msg.payload || {});
        if (!result.success) {
          ws.send(JSON.stringify({ event: 'error', message: result.message }));
        }
      } else if (msg.type === 'delete_officer' || msg.type === 'delete_admin') {
        deleteOfficerHandler(msg.payload || {});
      } else if (msg.type === 'update_window_quota') {
        updateWindowQuotaHandler(msg.payload || {});
      }
    } catch (err) {
      console.error('Error en procesamiento WebSocket:', err);
    }
  });

  ws.on('close', () => {
    clientsMap.delete(ws);
    broadcastPresence();
  });

  ws.on('error', () => {
    clientsMap.delete(ws);
    broadcastPresence();
  });
});

// Endpoint HTTP REST para consulta del estado autoritativo
app.get('/api/state', (req, res) => {
  const presence = getPresenceStats();
  res.json({
    adminOfficer: state.adminOfficer,
    registeredOfficers: state.registeredOfficers,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers,
    onlineCount: presence.onlineCount,
    mobileCount: presence.mobileCount,
    pcCount: presence.pcCount
  });
});

// Endpoints REST de contingencia y sincronización garantizada
app.post('/api/register', (req, res) => {
  const result = registerOfficerHandler(req.body);
  if (!result.success) {
    res.status(400).json(result);
  } else {
    res.json(result);
  }
});

app.post('/api/update', (req, res) => {
  const result = updateOfficerHandler(req.body);
  if (!result.success) {
    res.status(400).json(result);
  } else {
    res.json(result);
  }
});

app.post('/api/delete', (req, res) => {
  const result = deleteOfficerHandler(req.body);
  if (!result.success) {
    res.status(400).json(result);
  } else {
    res.json(result);
  }
});

app.post('/api/window_quota', (req, res) => {
  const result = updateWindowQuotaHandler(req.body);
  if (!result.success) {
    res.status(400).json(result);
  } else {
    res.json(result);
  }
});

// Endpoint de Monitoreo y Disponibilidad Continua 24/7
app.get('/api/health', (req, res) => {
  const presence = getPresenceStats();
  res.json({
    status: 'ONLINE_24_7',
    service: 'Military Registration Authority',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    totalOfficers: state.registeredOfficers.length,
    activeConnections: presence.onlineCount,
    deviceBreakdown: { mobile: presence.mobileCount, pc: presence.pcCount },
    quotas: state.quotas,
    memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024))
  });
});

app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send('PONG_24_7_READY');
});

// Endpoints de persistencia de Tema (Escudo, Fondos y Contraste)
app.get('/api/theme', (req, res) => {
  res.json(serverTheme || {});
});

app.post('/api/theme', (req, res) => {
  if (req.body && typeof req.body === 'object') {
    serverTheme = req.body;
    saveServerTheme(req.body);
    broadcast('theme:updated', serverTheme);
    res.json({ success: true, theme: serverTheme });
  } else {
    res.status(400).json({ success: false, message: 'Configuración de tema inválida.' });
  }
});

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);

    // Servir index.html transformado por Vite en modo desarrollo
    const fsModule = await import('fs');
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fsModule.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        if (e instanceof Error) vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Sistema Militar 24/7] Servidor activo en puerto ${PORT} — Monitoreo continuo habilitado.`);

    // Bucle Keep-Alive 24/7 Anti-Idle: Pings internos periódicos cada 3 minutos
    setInterval(() => {
      try {
        http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
          res.resume();
        }).on('error', () => {});
      } catch (e) {}
    }, 3 * 60 * 1000);

    // Auto-backup de seguridad en disco cada 5 minutos
    setInterval(() => {
      saveServerState();
    }, 5 * 60 * 1000);
  });
}

startServer();
