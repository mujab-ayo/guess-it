const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const GameSession = require("./GameSession");

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

const gameSession = new GameSession({ io });

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // First player creates the game and gets the join code
  socket.on("create_game", (event) => {
    gameSession.createGame({ socket, name: event.name });
  });

  // Everyone else joins with the code
  socket.on("join_game", (event) => {
    gameSession.join({ socket, name: event.name, code: event.code });
  });

  // Game master sets how many questions per session (3, 5, or 7)
  socket.on("set_questions", (event) => {
    gameSession.setQuestionsPerSession({ socket, count: event.count });
  });

  // Game master posts a question
  socket.on("create_question", (event) => {
    gameSession.createQuestion({ socket, event });
  });

  // A player submits a guess
  socket.on("guess_answer", (event) => {
    gameSession.guessAnswer({ socket, event });
  });

  // Game master starts a brand new game
  socket.on("start_new_game", () => {
    gameSession.startNewGame({ socket });
  });

  socket.on("disconnect", () => {
    gameSession.exit({ socket });
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
