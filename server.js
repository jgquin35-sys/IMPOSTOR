const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// Listas de palabras por categoría
const palabras = {
  animales: ['PERRO','GATO','LEON','TIGRE','VACA','CABALLO','RATON','PATO','OVEJA','MONO'],
  cuerpo: ['MANO','PIE','CABEZA','BRAZO','PIERNA','OJO','BOCA','NARIZ','ESPALDA','RODILLA'],
  paises: ['ESPAÑA','FRANCIA','ITALIA','PORTUGAL','MEXICO','ARGENTINA','ALEMANIA','JAPON','CHINA','BRASIL'],
  utensilios: ['CUCHARA','TENEDOR','CUCHILLO','PLATO','VASO','SARTEN','CAZO','TIJERAS','LAPIZ','BOLIGRAFO'],
  colores: ['ROJO','AZUL','VERDE','AMARILLO','NEGRO','BLANCO','ROSA','NARANJA','MORADO','MARRON'],
  deportes: ['FUTBOL','BALONCESTO','TENIS','PADEL','NATACION','CICLISMO','BALONMANO','GOLF','VOLEIBOL','ATLETISMO'],
  personajes: ['RAFA NADAL','FERNANDO ALONSO','PENÉLOPE CRUZ','ANTONIO BANDERAS','SHAKIRA','JULIO IGLESIAS','SERGIO RAMOS','ROSALIA','PAU GASOL','SALVADOR DALI']
};

function palabraAleatoriaGlobal() {
  const todas = Object.values(palabras).flat();
  return todas[Math.floor(Math.random() * todas.length)];
}

function palabraAleatoriaCategoria(cat) {
  const lista = palabras[cat] || [];
  if (!lista.length) return palabraAleatoriaGlobal();
  return lista[Math.floor(Math.random() * lista.length)];
}

// rooms[codigo] = { jugadores, palabraSecreta, impostorId, modo, categoria, hostNoImpostor, idHost, nombreHost, esperandoConfirmacion, confirmaciones }
const rooms = {};

io.on('connection', (socket) => {

  // HOST configura partida y crea sala
  socket.on('configurar-partida', (data) => {
    // data: { nombreHost, modo, categoria, palabraManual }
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();

    let palabraSecreta = '';
    if (data.modo === 'manual') {
      palabraSecreta = (data.palabraManual || '').toUpperCase();
    } else if (data.modo === 'random') {
      palabraSecreta = palabraAleatoriaGlobal();
    } else if (data.modo === 'randomCategoria') {
      palabraSecreta = palabraAleatoriaCategoria(data.categoria);
    }

    rooms[codigo] = {
      jugadores: [],
      palabraSecreta,
      impostorId: null,
      modo: data.modo,
      categoria: data.categoria || null,
      hostNoImpostor: data.modo === 'manual',
      idHost: socket.id,
      nombreHost: data.nombreHost,
      esperandoConfirmacion: false,
      confirmaciones: {} // { socketId: 'acepta' | 'rechaza' | 'pendiente' }
    };

    rooms[codigo].jugadores.push({
      id: socket.id,
      nombre: data.nombreHost,
      esHost: true
    });

    socket.join(codigo);
    socket.emit('partida-configurada', {
      codigo,
      palabraSecreta,
      modo: rooms[codigo].modo,
      categoria: rooms[codigo].categoria
    });
    io.to(codigo).emit('jugadores-actualizados', rooms[codigo].jugadores);
  });

  // Jugador se une a una sala ya configurada
  socket.on('unirse-partida', (data) => {
    const sala = rooms[data.codigo];
    if (!sala || !sala.palabraSecreta) {
      socket.emit('error-unirse', 'La partida no está lista todavía.');
      return;
    }
    sala.jugadores.push({ id: socket.id, nombre: data.nombre, esHost: false });
    socket.join(data.codigo);
    io.to(data.codigo).emit('jugadores-actualizados', sala.jugadores);
  });

  // Iniciar ronda (host)
  socket.on('iniciar-ronda', (codigo) => {
    const sala = rooms[codigo];
    if (!sala) return;
    if (sala.jugadores.length < 3) {
      io.to(codigo).emit('error-ronda', 'Se necesitan al menos 3 jugadores.');
      return;
    }

    const candidatos = sala.jugadores.filter(j => !(sala.hostNoImpostor && j.esHost));
    const impostor = candidatos[Math.floor(Math.random() * candidatos.length)];
    sala.impostorId = impostor.id;

    sala.jugadores.forEach(jugador => {
      if (jugador.id === sala.impostorId) {
        io.to(jugador.id).emit('tu-rol', {
          palabra: '¡ERES EL IMPOSTOR! Intenta descubrir la palabra.',
          impostor: true,
          modo: sala.modo,
          categoria: sala.categoria
        });
      } else {
        io.to(jugador.id).emit('tu-rol', {
          palabra: sala.palabraSecreta,
          impostor: false,
          modo: sala.modo,
          categoria: sala.categoria
        });
      }
    });
  });

  // NUEVA RONDA (mismo modo/categoría, con confirmación de todos)
  socket.on('solicitar-nueva-partida', (codigo) => {
    const sala = rooms[codigo];
    if (!sala) return;
    if (sala.esperandoConfirmacion) return;

    sala.esperandoConfirmacion = true;
    sala.confirmaciones = {};
    sala.jugadores.forEach(j => {
      sala.confirmaciones[j.id] = 'pendiente';
    });

    io.to(codigo).emit('nueva-partida-pedida', {
      codigo,
      segundos: 10
    });

    // tras 10 segundos
    setTimeout(() => {
      const s = rooms[codigo];
      if (!s) return;

      // filtrar aceptados
      s.jugadores = s.jugadores.filter(j => {
        const estado = s.confirmaciones[j.id];
        return estado === 'acepta';
      });

      // expulsar al resto
      Object.entries(s.confirmaciones).forEach(([id, estado]) => {
        if (estado !== 'acepta') {
          const sock = io.sockets.sockets.get(id);
          if (sock) {
            sock.leave(codigo);
            sock.emit('expulsado', 'No aceptaste la nueva partida a tiempo.');
          }
        }
      });

      s.esperandoConfirmacion = false;

      if (s.jugadores.length < 3) {
        io.to(codigo).emit('error-ronda', 'No hay suficientes jugadores para continuar.');
        io.to(codigo).emit('jugadores-actualizados', s.jugadores);
        return;
      }

      // Si el modo era aleatorio, generamos nueva palabra
      if (s.modo === 'random') {
        s.palabraSecreta = palabraAleatoriaGlobal();
      } else if (s.modo === 'randomCategoria') {
        s.palabraSecreta = palabraAleatoriaCategoria(s.categoria);
      }
      // En modo manual, mantenemos palabra hasta que host la cambie en el futuro si quieres.

      io.to(codigo).emit('jugadores-actualizados', s.jugadores);
      io.to(codigo).emit('estado-espera', 'Esperando a todos los jugadores...');
      io.to(codigo).emit('listo-para-nueva-ronda', { codigo });
    }, 10000);
  });

  // Respuesta de cada jugador a la nueva partida
  socket.on('respuesta-nueva-partida', (data) => {
    const sala = rooms[data.codigo];
    if (!sala || !sala.esperandoConfirmacion) return;
    if (!(socket.id in sala.confirmaciones)) return;
    sala.confirmaciones[socket.id] = data.acepta ? 'acepta' : 'rechaza';
  });

  // Nueva palabra manual (si quisieras usarla en el futuro)
  socket.on('nueva-palabra-manual', (data) => {
    const sala = rooms[data.codigo];
    if (!sala) return;
    sala.palabraSecreta = (data.palabra || '').toUpperCase();
    io.to(data.codigo).emit('nueva-palabra-generada', {
      codigo: data.codigo,
      palabraSecreta: sala.palabraSecreta,
      modo: sala.modo,
      categoria: sala.categoria
    });
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(codigo => {
      const sala = rooms[codigo];
      sala.jugadores = sala.jugadores.filter(j => j.id !== socket.id);
      if (!sala.jugadores.length) {
        delete rooms[codigo];
      } else {
        io.to(codigo).emit('jugadores-actualizados', sala.jugadores);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});

