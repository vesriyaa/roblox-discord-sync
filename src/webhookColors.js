const PALE = Object.freeze({ green: 0xb7d5bf, red: 0xd9afb5, yellow: 0xe5d7b2, blue: 0xb8ccdf });

function paleColor(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) return value;
  const channels = [value >> 16, (value >> 8) & 255, value & 255];
  // Already pale colors remain stable, including on repeated relay passes.
  if (Math.min(...channels) >= 170) return value;
  return channels.reduce((color, channel) => (color << 8) | Math.round(channel * 0.25 + 238 * 0.75), 0);
}

function softenEmbed(embed) {
  const data = typeof embed?.toJSON === "function" ? embed.toJSON() : embed;
  if (!data || typeof data !== "object") return data;
  return { ...data, ...(data.color === undefined ? {} : { color: paleColor(data.color) }) };
}

module.exports = { PALE, paleColor, softenEmbed };
