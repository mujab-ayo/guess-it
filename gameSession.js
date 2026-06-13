const Player = require("./player");
const Question = require("./question");
const Timer = require("./timer");

const GAME_STATES = {
  WAITING: "waiting",
  IN_PROGRESS: "in_progress",
  BETWEEN: "between",
  SESSION_END: "session_end", 
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const VALID_COUNTS = [3, 5, 7];

function generateCode() {
  const words = [
    "BLUE",
    "FIRE",
    "GOLD",
    "STAR",
    "LION",
    "WOLF",
    "JADE",
    "NEON",
    "BOLT",
    "SAGE",
  ];
  return `${words[Math.floor(Math.random() * words.length)]}${Math.floor(Math.random() * 90) + 10}`;
}

class GameSession {
  constructor({ io }) {
    this.io = io;
    this.players = [];
    this.playersIndex = {};
    this.question = null;
    this.gameMaster = null;
    this.state = GAME_STATES.WAITING;
    this.timer = new Timer({ gameSession: this });
    this.events = [];
    this.joinCode = null;
    this.questionsPerSession = 5;
    this.questionInSession = 0;
    this.globalRound = 0;
  }

  createGame({ socket, name }) {
    if (!name || !name.trim().length) {
      socket.emit("join_error", { message: "Please enter a name." });
      return;
    }
    if (this.players.length > 0) {
      socket.emit("join_error", {
        message: "A game already exists. Join with a code.",
      });
      return;
    }

    this.joinCode = generateCode();
    const player = new Player({
      name: name.trim(),
      id: socket.id,
      isGameMaster: true,
    });
    this.players.push(player);
    this.playersIndex[socket.id] = player;
    this.gameMaster = player;

    socket.emit("game_created", {
      joinCode: this.joinCode,
      player,
      players: this.players,
      gameMaster: this.gameMaster,
      questionsPerSession: this.questionsPerSession,
      minPlayers: MIN_PLAYERS,
    });
  }

  join({ socket, name, code }) {
    if (!name || !name.trim().length) {
      socket.emit("join_error", { message: "Please enter a name." });
      return;
    }
    if (!code || code.trim().toUpperCase() !== this.joinCode) {
      socket.emit("join_error", {
        message: "Invalid game code. Check and try again.",
      });
      return;
    }
    if (this.state === GAME_STATES.IN_PROGRESS) {
      socket.emit("join_error", {
        message: `Session in progress. Try again in ${this.timer.secondsLeft()}s.`,
      });
      return;
    }
    if (this.players.length >= MAX_PLAYERS) {
      socket.emit("join_error", {
        message: `Game is full (max ${MAX_PLAYERS} players).`,
      });
      return;
    }
    const nameTaken = this.players.some(
      (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (nameTaken) {
      socket.emit("join_error", {
        message: `Name "${name}" is already taken.`,
      });
      return;
    }

    const player = new Player({
      name: name.trim(),
      id: socket.id,
      isGameMaster: false,
    });
    this.players.push(player);
    this.playersIndex[socket.id] = player;

    this.emitEvent({
      eventName: "player_joined",
      message: `${player.name} joined`,
      data: {
        player,
        players: this.players,
        gameMaster: this.gameMaster,
        questionsPerSession: this.questionsPerSession,
        minPlayers: MIN_PLAYERS,
      },
    });
  }

  setQuestionsPerSession({ socket, count }) {
    const player = this.playersIndex[socket.id];
    if (!player || !player.isGameMaster) {
      socket.emit("join_error", {
        message: "Only the game master can set this.",
      });
      return;
    }
    if (!VALID_COUNTS.includes(count)) {
      socket.emit("join_error", { message: "Must be 3, 5, or 7." });
      return;
    }
    this.questionsPerSession = count;
    this.emitEvent({
      eventName: "session_config_updated",
      message: `Questions per session set to ${count}`,
      data: { questionsPerSession: count },
    });
  }

  createQuestion({ socket, event }) {
    const player = this.playersIndex[socket.id];
    if (!player || !player.isGameMaster) {
      socket.emit("join_error", {
        message: "Only the game master can post a question.",
      });
      return;
    }
    if (this.state === GAME_STATES.IN_PROGRESS) return;
    if (this.state === GAME_STATES.SESSION_END) return;
    if (this.players.length < MIN_PLAYERS) {
      socket.emit("join_error", {
        message: `Need at least ${MIN_PLAYERS} players. Currently ${this.players.length}.`,
      });
      return;
    }

    this.questionInSession += 1;
    this.globalRound += 1;
    this.question = new Question({
      question: event.question,
      answer: event.answer,
    });
    this.state = GAME_STATES.IN_PROGRESS;

    this.emitEvent({
      eventName: "question_created",
      message: `Q${this.questionInSession}: ${this.question.question}`,
      data: {
        question: this.question.question,
        questionInSession: this.questionInSession,
        questionsPerSession: this.questionsPerSession,
        globalRound: this.globalRound,
      },
    });

    this.timer.start();

    this.timer.onTimeExpired((gs) => {
      gs.emitEvent({
        eventName: "time_expired",
        message: `Time's up! The answer was: ${this.question.answer}`,
        data: { players: this.players },
      });
      gs.state = GAME_STATES.BETWEEN;
      gs._endQuestion();
    });
  }

  guessAnswer({ socket, event }) {
    if (this.state !== GAME_STATES.IN_PROGRESS) return;
    const player = this.playersIndex[socket.id];
    if (!player) return;
    if (player.isGameMaster) {
      socket.emit("join_error", {
        message: "Game master cannot guess their own question.",
      });
      return;
    }

    const isCorrect = this.question.isAnswer(event.answer);

    if (!isCorrect) {
      this.emitEvent({
        eventName: "guess",
        message: `${player.name} guessed "${event.answer}" — wrong!`,
        data: { isCorrect, playerName: player.name },
      });
    } else {
      player.score += 10;
      this.timer.stop();
      this.state = GAME_STATES.BETWEEN;
      this.emitEvent({
        eventName: "guess",
        message: `${player.name} got it! +10 pts`,
        data: { isCorrect, playerName: player.name, players: this.players },
      });
      this._endQuestion();
    }
  }

  _endQuestion() {
    const sessionDone = this.questionInSession >= this.questionsPerSession;

    if (sessionDone) {
      this.state = GAME_STATES.SESSION_END;
      this.emitEvent({
        eventName: "session_complete",
        message: "Session complete!",
        data: {
          players: [...this.players].sort((a, b) => b.score - a.score),
          globalRound: this.globalRound,
          gameMaster: this.gameMaster,
          questionsPerSession: this.questionsPerSession,
        },
      });
    } else {
      this.state = GAME_STATES.BETWEEN;
      this.emitEvent({
        eventName: "question_complete",
        message: `Question ${this.questionInSession} of ${this.questionsPerSession} done`,
        data: {
          players: [...this.players].sort((a, b) => b.score - a.score),
          questionInSession: this.questionInSession,
          questionsPerSession: this.questionsPerSession,
          globalRound: this.globalRound,
          gameMaster: this.gameMaster,
        },
      });
    }
  }

  startAnotherSession({ socket }) {
    const player = this.playersIndex[socket.id];
    if (!player || !player.isGameMaster) {
      socket.emit("join_error", {
        message: "Only the current game master can start the next session.",
      });
      return;
    }
    if (this.state !== GAME_STATES.SESSION_END) return;

    for (const p of this.players) {
      if (p.isGameMaster) {
        p.setGameMaster(false);
        break;
      }
    }

    this.questionInSession = 0;

    const idx = Math.floor(Math.random() * this.players.length);
    const newMaster = this.players[idx];
    newMaster.setGameMaster(true);
    this.gameMaster = newMaster;
    this.state = GAME_STATES.WAITING;

    this.emitEvent({
      eventName: "new_session_started",
      message: `New session! ${newMaster.name} is Game Master.`,
      data: {
        players: this.players,
        gameMaster: this.gameMaster,
        questionsPerSession: this.questionsPerSession,
      },
    });
  }

  exit({ socket }) {
    const leaving = this.playersIndex[socket.id];
    if (!leaving) return;

    this.players = this.players.filter((p) => p.id !== socket.id);
    delete this.playersIndex[socket.id];

    if (this.players.length === 0) {
      this.timer.stop();
      this.state = GAME_STATES.WAITING;
      this.gameMaster = null;
      this.question = null;
      this.questionInSession = 0;
      this.globalRound = 0;
      this.joinCode = null;
      return;
    }

    if (leaving.isGameMaster) {
      this.timer.stop();
      this.state = GAME_STATES.WAITING;
      this.questionInSession = 0;
      const idx = Math.floor(Math.random() * this.players.length);
      const newMaster = this.players[idx];
      newMaster.setGameMaster(true);
      this.gameMaster = newMaster;
    }

    this.emitEvent({
      eventName: "player_left",
      message: `${leaving.name} left`,
      data: { players: this.players, gameMaster: this.gameMaster },
    });
  }

  emitEvent({ eventName, message, data }) {
    const event = { eventName, message, data };
    this.events.push(event);
    this.io.emit(eventName, event);
  }
}

module.exports = GameSession;
