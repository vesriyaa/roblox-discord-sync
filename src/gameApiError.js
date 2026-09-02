class GameApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "GameApiError";
    this.status = status;
    this.code = code;
  }
}

module.exports = { GameApiError };
