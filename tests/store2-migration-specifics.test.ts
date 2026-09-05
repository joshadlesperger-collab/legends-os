import assert from "node:assert/strict";
import test from "node:test";
import {
  findStore2MigrationSpecificDifferences,
  serializeStore2MigrationItemSpecificsXml,
} from "../lib/store2-migration-specifics.ts";

const league =
  "National Collegiate Athletic Association (NCAA), National Football League (NFL)";

test("migration XML serializes verified overlength fields as multiple values", () => {
  const xml = serializeStore2MigrationItemSpecificsXml([
    { name: "Sport", value: "Football" },
    { name: "League", value: league },
  ]);

  assert.match(
    xml,
    /<NameValueList><Name>League<\/Name><Value>National Collegiate Athletic Association \(NCAA\)<\/Value><Value>National Football League \(NFL\)<\/Value><\/NameValueList>/,
  );
  assert.doesNotMatch(xml, /<Value>National Collegiate.*National Football League/);
});

test("migration XML continues to fail closed for unsafe overlength identity fields", () => {
  assert.throws(
    () =>
      serializeStore2MigrationItemSpecificsXml([
        { name: "Player/Athlete", value: "x".repeat(66) },
      ]),
    /Unsafe migration aspect: Player\/Athlete/,
  );
});

test("provider reconciliation accepts array or comma-delimited equivalent values", () => {
  const expected = [{ name: "League", value: league }];

  assert.deepEqual(
    findStore2MigrationSpecificDifferences(expected, [
      {
        name: "League",
        values: [
          "National Collegiate Athletic Association (NCAA)",
          "National Football League (NFL)",
        ],
      },
    ]),
    [],
  );

  assert.deepEqual(
    findStore2MigrationSpecificDifferences(expected, [
      { name: "League", values: [league] },
    ]),
    [],
  );
});

test("provider reconciliation rejects missing or materially changed values", () => {
  const expected = [{ name: "League", value: league }];

  assert.deepEqual(findStore2MigrationSpecificDifferences(expected, []), [
    "specific:League",
  ]);
  assert.deepEqual(
    findStore2MigrationSpecificDifferences(expected, [
      {
        name: "League",
        values: ["National Football League (NFL)"],
      },
    ]),
    ["specific:League"],
  );
});
