const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const GameSession = require("./GameSession");

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));

const gameSession = new GameSession({ io });

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("create_game", (e) =>
    gameSession.createGame({ socket, name: e.name }),
  );
  socket.on("join_game", (e) =>
    gameSession.join({ socket, name: e.name, code: e.code }),
  );
  socket.on("set_questions", (e) =>
    gameSession.setQuestionsPerSession({ socket, count: e.count }),
  );
  socket.on("create_question", (e) =>
    gameSession.createQuestion({ socket, event: e }),
  );
  socket.on("guess_answer", (e) =>
    gameSession.guessAnswer({ socket, event: e }),
  );
  socket.on("start_another_session", () =>
    gameSession.startAnotherSession({ socket }),
  );

  socket.on("disconnect", () => {
    gameSession.exit({ socket });
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3000, () =>
  console.log("Server running at http://localhost:3000"),
);
