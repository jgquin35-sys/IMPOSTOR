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

// rooms[codigo] = { jugadores: [{id,nombre,esHost}], palabraSecreta, impostorId, modo, categoria, hostNoImpostor }
const rooms = {};

io.on('connection', (socket) => {
  // Host crea la sala con configuración, pero sin jugadores aún
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
      nombreHost: data.nombreHost
    };

    // El host entra como primer jugador
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

  // Jugadores se unen cuando ya hay palabra y sala creada
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

  // Host inicia ronda (o nueva ronda)
  socket.on('iniciar-ronda', (codigo) => {
    const sala = rooms[codigo];
    if (!sala) return;
    if (sala.jugadores.length < 3) {
      io.to(codigo).emit('error-ronda', 'Se necesitan al menos 3 jugadores.');
      return;
    }

    // Elegir impostor
    const candidatos = sala.jugadores.filter(j => !(sala.hostNoImpostor && j.esHost));
    const impostor = candidatos[Math.floor(Math.random() * candidatos.length)];
    sala.impostorId = impostor.id;

    // Enviar palabras
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

  // Nueva ronda (misma sala, mismo modo y categoría; nueva palabra si es aleatoria)
  socket.on('nueva-ronda', (codigo) => {
    const sala = rooms[codigo];
    if (!sala) return;

    if (sala.modo === 'manual') {
      // En modo manual pediremos nueva palabra al host desde el cliente
      io.to(sala.idHost).emit('solicitar-nueva-palabra-manual', {
        codigo,
        modo: sala.modo,
        categoria: sala.categoria
      });
    } else if (sala.modo === 'random') {
      sala.palabraSecreta = palabraAleatoriaGlobal();
      io.to(codigo).emit('nueva-palabra-generada', {
        codigo,
        palabraSecreta: sala.palabraSecreta,
        modo: sala.modo,
        categoria: sala.categoria
      });
    } else if (sala.modo === 'randomCategoria') {
      sala.palabraSecreta = palabraAleatoriaCategoria(sala.categoria);
      io.to(codigo).emit('nueva-palabra-generada', {
        codigo,
        palabraSecreta: sala.palabraSecreta,
        modo: sala.modo,
        categoria: sala.categoria
      });
    }
  });

  // Host envía nueva palabra manual para la nueva ronda
  socket.on('nueva-palabra-manual', (data) => {
    // data: { codigo, palabra }
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
    // Limpieza sencilla: quitar jugadores de salas
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

