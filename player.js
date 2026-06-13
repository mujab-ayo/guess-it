class Player {
  constructor({ name, id, isGameMaster = false }) {
    this.id = id;
    this.name = name;
    this.isGameMaster = isGameMaster;
    this.score = 0;
  }

  setGameMaster(bool) {
    this.isGameMaster = bool;
  }
}

module.exports = Player;
