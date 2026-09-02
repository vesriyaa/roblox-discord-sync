const test = require("node:test");
const assert = require("node:assert/strict");
const { isAccessManagementChannel } = require("../src/accessManagementPolicy");

test("access actions are restricted to the configured hidden channel", () => {
  assert.equal(isAccessManagementChannel("1415902350232784991", "1415902350232784991"), true);
  assert.equal(isAccessManagementChannel("another-channel", "1415902350232784991"), false);
  assert.equal(isAccessManagementChannel("another-channel", ""), true);
});
