const Player = require('./Player');
const Question = require('./Question');
const Timer = require('./Timer');

const GAME_STATES = {
    WAITING:     'waiting',      // lobby — no session running
    IN_PROGRESS: 'in_progress',  // a question is currently active
    BETWEEN:     'between',      // question ended, waiting for next within same session
    FINISHED:    'finished',     // all sessions done — game over screen
};

const MIN_PLAYERS   = 3;
const MAX_PLAYERS   = 8;
const VALID_COUNTS  = [3, 5, 7];

// Generates a 6-character join code e.g. "BLUE42"
function generateCode() {
    const words = ['BLUE','FIRE','GOLD','STAR','LION','WOLF','JADE','NEON','BOLT','SAGE'];
    const word   = words[Math.floor(Math.random() * words.length)];
    const num    = Math.floor(Math.random() * 90) + 10;
    return `${word}${num}`;
}

class GameSession {
    constructor({ io }) {
        this.io          = io;
        this.players     = [];
        this.playersIndex= {};
        this.question    = null;
        this.gameMaster  = null;
        this.state       = GAME_STATES.WAITING;
        this.timer       = new Timer({ gameSession: this });
        this.events      = [];

        // Join code — generated when first player creates the game
        this.joinCode    = null;

        // Session = one game master's turn to ask N questions
        this.questionsPerSession = 5;   // game master chooses 3, 5, or 7
        this.questionInSession   = 0;   // how many questions THIS master has asked

        // Global round counter across all sessions (for display)
        this.globalRound = 0;
    }

    // ── CREATE GAME (first player — becomes game master, gets the code) ──
    createGame({ socket, name }) {
        if (!name || !name.trim().length) {
            socket.emit('join_error', { message: 'Please enter a name.' });
            return;
        }
        if (this.players.length > 0) {
            socket.emit('join_error', { message: 'A game already exists. Join with a code.' });
            return;
        }

        // Generate unique join code
        this.joinCode = generateCode();

        const player = new Player({ name: name.trim(), id: socket.id, isGameMaster: true });
        this.players.push(player);
        this.playersIndex[socket.id] = player;
        this.gameMaster = player;

        // Send the code ONLY to the host
        socket.emit('game_created', {
            joinCode: this.joinCode,
            player,
            players: this.players,
            gameMaster: this.gameMaster,
            questionsPerSession: this.questionsPerSession,
            minPlayers: MIN_PLAYERS,
        });
    }

    // ── JOIN (players enter the code) ────────────────────────
    join({ socket, name, code }) {
        if (!name || !name.trim().length) {
            socket.emit('join_error', { message: 'Please enter a name.' });
            return;
        }
        if (!code || code.trim().toUpperCase() !== this.joinCode) {
            socket.emit('join_error', { message: 'Invalid game code. Check and try again.' });
            return;
        }
        if (this.state === GAME_STATES.IN_PROGRESS) {
            socket.emit('join_error', {
                message: `Session in progress. Try again in ${this.timer.secondsLeft()}s.`,
            });
            return;
        }
        if (this.state === GAME_STATES.FINISHED) {
            socket.emit('join_error', { message: 'Game has ended. Wait for host to start a new one.' });
            return;
        }
        if (this.players.length >= MAX_PLAYERS) {
            socket.emit('join_error', { message: `Game is full (max ${MAX_PLAYERS} players).` });
            return;
        }
        const nameTaken = this.players.some(
            p => p.name.toLowerCase() === name.trim().toLowerCase()
        );
        if (nameTaken) {
            socket.emit('join_error', { message: `Name "${name}" is already taken.` });
            return;
        }

        const player = new Player({ name: name.trim(), id: socket.id, isGameMaster: false });
        this.players.push(player);
        this.playersIndex[socket.id] = player;

        // Broadcast to everyone that someone joined
        this.emitEvent({
            eventName: 'player_joined',
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

    // ── SET QUESTIONS PER SESSION ─────────────────────────────
    setQuestionsPerSession({ socket, count }) {
        const player = this.playersIndex[socket.id];
        if (!player || !player.isGameMaster) {
            socket.emit('join_error', { message: 'Only the game master can set this.' });
            return;
        }
        if (!VALID_COUNTS.includes(count)) {
            socket.emit('join_error', { message: 'Must be 3, 5, or 7.' });
            return;
        }
        this.questionsPerSession = count;
        this.emitEvent({
            eventName: 'session_config_updated',
            message: `Game master set ${count} questions per session`,
            data: { questionsPerSession: count },
        });
    }

    // ── CREATE QUESTION ──────────────────────────────────────
    createQuestion({ socket, event }) {
        const player = this.playersIndex[socket.id];

        if (!player || !player.isGameMaster) {
            socket.emit('join_error', { message: 'Only the game master can post a question.' });
            return;
        }
        if (this.state === GAME_STATES.IN_PROGRESS) return;
        if (this.state === GAME_STATES.FINISHED) return;

        if (this.players.length < MIN_PLAYERS) {
            socket.emit('join_error', {
                message: `Need at least ${MIN_PLAYERS} players. Currently ${this.players.length}.`,
            });
            return;
        }

        this.questionInSession += 1;
        this.globalRound       += 1;
        this.question           = new Question({ question: event.question, answer: event.answer });
        this.state              = GAME_STATES.IN_PROGRESS;

        this.emitEvent({
            eventName: 'question_created',
            message: `Q${this.questionInSession}: ${this.question.question}`,
            data: {
                question:            this.question.question,
                questionInSession:   this.questionInSession,
                questionsPerSession: this.questionsPerSession,
                globalRound:         this.globalRound,
            },
        });

        this.timer.start();

        this.timer.onTimeExpired((gs) => {
            gs.emitEvent({
                eventName: 'time_expired',
                message:   `Time's up! The answer was: ${this.question.answer}`,
                data:      { players: this.players },
            });
            gs.state = GAME_STATES.BETWEEN;
            gs._endQuestion({ answered: false });
        });
    }

    // ── GUESS ────────────────────────────────────────────────
    guessAnswer({ socket, event }) {
        if (this.state !== GAME_STATES.IN_PROGRESS) return;

        const player = this.playersIndex[socket.id];
        if (!player) return;

        if (player.isGameMaster) {
            socket.emit('join_error', { message: 'Game master cannot guess their own question.' });
            return;
        }

        const isCorrect = this.question.isAnswer(event.answer);

        if (!isCorrect) {
            this.emitEvent({
                eventName: 'guess',
                message:   `${player.name} guessed "${event.answer}" — wrong!`,
                data:      { isCorrect, playerName: player.name },
            });
        } else {
            player.score += 10;
            this.timer.stop();
            this.state = GAME_STATES.BETWEEN;

            this.emitEvent({
                eventName: 'guess',
                message:   `${player.name} got it! Answer: "${event.answer}" +10 pts`,
                data:      { isCorrect, playerName: player.name, players: this.players },
            });

            this._endQuestion({ answered: true });
        }
    }

    // ── END QUESTION ─────────────────────────────────────────
    // Called after every question ends (correct guess OR timer expiry)
    _endQuestion({ answered }) {
        const sessionComplete = this.questionInSession >= this.questionsPerSession;

        if (sessionComplete) {
            // This game master's session is done
            this._endSession();
        } else {
            // Same game master asks the next question
            this.state = GAME_STATES.BETWEEN;

            // Emit progress so everyone can see the current scores
            // and game master knows to post next question
            this.emitEvent({
                eventName: 'question_complete',
                message:   `Question ${this.questionInSession} of ${this.questionsPerSession} done`,
                data: {
                    players:             [...this.players].sort((a,b) => b.score - a.score),
                    questionInSession:   this.questionInSession,
                    questionsPerSession: this.questionsPerSession,
                    globalRound:         this.globalRound,
                    gameMaster:          this.gameMaster,
                },
            });
        }
    }

    // ── END SESSION (game master's full set of questions done) ─
    _endSession() {
        this.state = GAME_STATES.WAITING;
        this.timer.stop();

        const sorted = [...this.players].sort((a, b) => b.score - a.score);

        this.emitEvent({
            eventName: 'session_complete',
            message:   `Session complete! Scores after ${this.globalRound} questions total`,
            data: {
                players:     sorted,
                globalRound: this.globalRound,
                gameMaster:  this.gameMaster,
            },
        });

        // Now rotate to a new game master — this starts the next session
        this._assignNewGameMaster();
    }

    // ── ASSIGN NEW GAME MASTER ───────────────────────────────
    _assignNewGameMaster({ skipScores = false } = {}) {
        if (this.players.length === 0) return;

        // Strip master flag from current holder
        for (const p of this.players) {
            if (p.isGameMaster) { p.setGameMaster(false); break; }
        }

        // Reset session question counter for the new master
        this.questionInSession = 0;

        const idx       = Math.floor(Math.random() * this.players.length);
        const newMaster = this.players[idx];
        newMaster.setGameMaster(true);
        this.gameMaster = newMaster;
        this.state      = GAME_STATES.WAITING;

        this.emitEvent({
            eventName: 'new_game_master',
            message:   `${newMaster.name} is the new Game Master!`,
            data: {
                players:             this.players,
                gameMaster:          this.gameMaster,
                questionsPerSession: this.questionsPerSession,
                globalRound:         this.globalRound,
            },
        });
    }

    // ── GAME OVER ────────────────────────────────────────────
    _endGame() {
        this.state = GAME_STATES.FINISHED;
        this.timer.stop();
        const sorted = [...this.players].sort((a, b) => b.score - a.score);
        this.emitEvent({
            eventName: 'game_over',
            message:   'Game over! Final scores:',
            data:      { players: sorted, winner: sorted[0] },
        });
    }

    // ── START NEW GAME ───────────────────────────────────────
    startNewGame({ socket }) {
        const player = this.playersIndex[socket.id];
        if (!player || !player.isGameMaster) {
            socket.emit('join_error', { message: 'Only the game master can start a new game.' });
            return;
        }

        for (const p of this.players) { p.score = 0; p.setGameMaster(false); }

        this.question          = null;
        this.questionInSession = 0;
        this.globalRound       = 0;
        this.state             = GAME_STATES.WAITING;
        this.timer.stop();

        // Generate a new join code for the new game
        this.joinCode = generateCode();

        const idx       = Math.floor(Math.random() * this.players.length);
        const newMaster = this.players[idx];
        newMaster.setGameMaster(true);
        this.gameMaster = newMaster;

        this.emitEvent({
            eventName: 'new_game_started',
            message:   `New game! ${newMaster.name} is Game Master.`,
            data: {
                players:             this.players,
                gameMaster:          this.gameMaster,
                questionsPerSession: this.questionsPerSession,
                joinCode:            this.joinCode,
            },
        });
    }

    // ── EXIT ─────────────────────────────────────────────────
    exit({ socket }) {
        const leaving = this.playersIndex[socket.id];
        if (!leaving) return;

        this.players = this.players.filter(p => p.id !== socket.id);
        delete this.playersIndex[socket.id];

        if (this.players.length === 0) {
            this.timer.stop();
            this.state             = GAME_STATES.WAITING;
            this.gameMaster        = null;
            this.question          = null;
            this.questionInSession = 0;
            this.globalRound       = 0;
            this.joinCode          = null;
            return;
        }

        if (leaving.isGameMaster) {
            this.timer.stop();
            this.state             = GAME_STATES.WAITING;
            this.questionInSession = 0;
            this._assignNewGameMaster({ skipScores: true });
        }

        this.emitEvent({
            eventName: 'player_left',
            message:   `${leaving.name} left`,
            data:      { players: this.players, gameMaster: this.gameMaster },
        });
    }

    // ── EMIT ─────────────────────────────────────────────────
    emitEvent({ eventName, message, data }) {
        const event = { eventName, message, data };
        this.events.push(event);
        this.io.emit(eventName, event);
    }
}

module.exports = GameSession;