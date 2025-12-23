const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Servir los archivos estáticos de la carpeta "public"
app.use(express.static('public'));

const rooms = {}; // { codigo: { jugadores: [], palabraSecreta: "", impostor: null } }

io.on('connection', (socket) => {
  socket.on('crear-partida', (data) => {
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[codigo] = {
      jugadores: [{ id: socket.id, nombre: data.nombre }],
      palabraSecreta: data.palabra,
      impostor: null
    };
    socket.join(codigo);
    socket.emit('partida-creada', codigo);
  });

  socket.on('unirse-partida', (data) => {
    const sala = rooms[data.codigo];
    if (!sala) return;

    sala.jugadores.push({ id: socket.id, nombre: data.nombre });
    socket.join(data.codigo);
    io.to(data.codigo).emit('jugador-unido', sala.jugadores);

    // Cuando haya al menos 3 jugadores, asignar impostor y palabras
    if (!sala.impostor && sala.jugadores.length >= 3) {
      const impostorIndex = Math.floor(Math.random() * sala.jugadores.length);
      sala.impostor = sala.jugadores[impostorIndex].id;

      sala.jugadores.forEach(jugador => {
        if (jugador.id === sala.impostor) {
          io.to(jugador.id).emit('tu-palabra', {
            palabra: '¡ERES EL IMPOSTOR! Intenta descubrir la palabra secreta',
            impostor: true
          });
        } else {
          io.to(jugador.id).emit('tu-palabra', {
            palabra: sala.palabraSecreta,
            impostor: false
          });
        }
      });
    }
  });
});

// Usar el puerto que da Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
