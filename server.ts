import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

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

export interface AdminOfficer {
  id: string;
  rank: string;
  fullName: string;
  commissionId: string;
  commissionName: string;
  role: 'ADMINISTRADOR';
  timestamp: string;
}

// Estado autoritativo centralizado: SOLO 1 USUARIO ADMINISTRADOR PERMITIDO
const state = {
  adminOfficer: null as AdminOfficer | null,
  quotas: {} as Record<string, number>,
  assignedOfficers: {} as Record<string, AdminOfficer[]>
};

// Inicializar cupos
COMMISSIONS_DATA.forEach(c => {
  state.quotas[c.id] = c.maxQuota;
  state.assignedOfficers[c.id] = [];
});

function broadcast(event: string, payload: any) {
  const message = JSON.stringify({ event, payload, timestamp: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastPresence() {
  broadcast('presence:update', {
    onlineCount: wss.clients.size
  });
}

function registerAdminHandler(payload: { id?: string; rank: string; fullName: string; commissionId: string }) {
  if (state.adminOfficer !== null) {
    return { success: false, message: 'BLOQUEO: Solamente un usuario puede registrarse como Administrador.' };
  }
  const { id, rank, fullName, commissionId } = payload;
  if (!state.quotas[commissionId] || state.quotas[commissionId] <= 0) {
    return { success: false, message: 'La comisión seleccionada no tiene cupos disponibles.' };
  }

  const com = COMMISSIONS_DATA.find(c => c.id === commissionId);
  const newAdmin: AdminOfficer = {
    id: id || 'admin_' + Date.now(),
    rank,
    fullName: (fullName || '').toUpperCase(),
    commissionId,
    commissionName: com ? com.name : commissionId,
    role: 'ADMINISTRADOR',
    timestamp: new Date().toLocaleTimeString()
  };

  state.adminOfficer = newAdmin;
  state.quotas[commissionId] -= 1;
  state.assignedOfficers[commissionId] = [newAdmin];

  broadcast('admin:registered', {
    adminOfficer: newAdmin,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers
  });

  return { success: true, adminOfficer: newAdmin, quotas: state.quotas, assignedOfficers: state.assignedOfficers };
}

function updateAdminHandler(payload: { rank: string; fullName: string; commissionId: string; oldCommissionId?: string }) {
  if (!state.adminOfficer) {
    return { success: false, message: 'No existe un administrador registrado para modificar.' };
  }

  const { rank, fullName, commissionId, oldCommissionId } = payload;

  if (oldCommissionId && oldCommissionId !== commissionId) {
    if (!state.quotas[commissionId] || state.quotas[commissionId] <= 0) {
      return { success: false, message: 'Sin cupos en la nueva comisión seleccionada.' };
    }
    state.quotas[oldCommissionId] = (state.quotas[oldCommissionId] || 0) + 1;
    state.quotas[commissionId] -= 1;
    state.assignedOfficers[oldCommissionId] = [];
  }

  const com = COMMISSIONS_DATA.find(c => c.id === commissionId);
  const updatedAdmin: AdminOfficer = {
    ...state.adminOfficer,
    rank,
    fullName: (fullName || '').toUpperCase(),
    commissionId,
    commissionName: com ? com.name : commissionId,
    timestamp: new Date().toLocaleTimeString()
  };

  state.adminOfficer = updatedAdmin;
  state.assignedOfficers[commissionId] = [updatedAdmin];

  broadcast('admin:updated', {
    adminOfficer: updatedAdmin,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers
  });

  return { success: true, adminOfficer: updatedAdmin, quotas: state.quotas, assignedOfficers: state.assignedOfficers };
}

function deleteAdminHandler() {
  if (!state.adminOfficer) {
    return { success: false, message: 'No existe un administrador registrado para borrar.' };
  }

  const comId = state.adminOfficer.commissionId;
  if (state.quotas[comId] !== undefined) {
    state.quotas[comId] += 1;
  }

  state.adminOfficer = null;
  state.assignedOfficers[comId] = [];

  broadcast('admin:deleted', {
    adminOfficer: null,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers
  });

  return { success: true, quotas: state.quotas, assignedOfficers: state.assignedOfficers };
}

function updateWindowQuotaHandler(payload: { commissionId: string; newQuota: number }) {
  const { commissionId, newQuota } = payload;
  if (commissionId && typeof newQuota === 'number' && newQuota >= 0) {
    state.quotas[commissionId] = newQuota;
    broadcast('window:quota_updated', {
      commissionId,
      quotas: state.quotas,
      assignedOfficers: state.assignedOfficers
    });
    return { success: true, commissionId, quotas: state.quotas, assignedOfficers: state.assignedOfficers };
  }
  return { success: false, message: 'Cupo o comisión inválidos.' };
}

wss.on('connection', (ws) => {
  broadcastPresence();

  // Enviar estado íntegro y datos del administrador al cliente conectado
  ws.send(JSON.stringify({
    event: 'sync:state',
    payload: {
      adminOfficer: state.adminOfficer,
      quotas: state.quotas,
      assignedOfficers: state.assignedOfficers,
      onlineCount: wss.clients.size
    }
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'register_admin') {
        const result = registerAdminHandler(msg.payload);
        if (!result.success) {
          ws.send(JSON.stringify({ event: 'error', message: result.message }));
        }
      } else if (msg.type === 'update_admin') {
        const result = updateAdminHandler(msg.payload);
        if (!result.success) {
          ws.send(JSON.stringify({ event: 'error', message: result.message }));
        }
      } else if (msg.type === 'delete_admin') {
        deleteAdminHandler();
      } else if (msg.type === 'update_window_quota') {
        updateWindowQuotaHandler(msg.payload);
      }
    } catch (err) {
      console.error('Error en procesamiento WebSocket:', err);
    }
  });

  ws.on('close', () => {
    broadcastPresence();
  });
});

// Endpoint HTTP REST para consulta del estado autoritativo
app.get('/api/state', (req, res) => {
  res.json({
    adminOfficer: state.adminOfficer,
    quotas: state.quotas,
    assignedOfficers: state.assignedOfficers,
    onlineCount: wss.clients.size
  });
});

// Endpoints REST de contingencia y sincronización garantizada
app.post('/api/register', (req, res) => {
  const result = registerAdminHandler(req.body);
  if (!result.success) {
    res.status(400).json(result);
  } else {
    res.json(result);
  }
});

app.post('/api/update', (req, res) => {
  const result = updateAdminHandler(req.body);
  if (!result.success) {
    res.status(400).json(result);
  } else {
    res.json(result);
  }
});

app.post('/api/delete', (req, res) => {
  const result = deleteAdminHandler();
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
    const fs = await import('fs');
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
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
    console.log(`Servidor Administrativo Militar en tiempo real activo en puerto ${PORT}`);
  });
}

startServer();
