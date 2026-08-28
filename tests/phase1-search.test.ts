import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMailQuery, parseSearchQuery } from "../worker/index.ts";

test("parses quoted phrases, negation, fields, dates, and sizes", () => {
  const parsed = parseSearchQuery('from:alice@example.com "project launch" -is:read has:attachment after:7d larger:5MB');

  assert.deepEqual(parsed.terms, []);
  assert.deepEqual(parsed.phrases, [{ value: "project launch", negated: false }]);
  assert.equal(parsed.filters.length, 5);
  assert.deepEqual(parsed.filters[0], { kind: "field", field: "from", value: "alice@example.com", negated: false });
  assert.deepEqual(parsed.filters[1], { kind: "state", field: "is_read", value: true, negated: true });
  assert.deepEqual(parsed.filters[2], { kind: "state", field: "has_attachment", value: true, negated: false });
  assert.equal(parsed.filters[3].kind, "date");
  assert.match(parsed.normalized, /larger:5MB/);
});

test("rejects malformed and unknown operators with actionable errors", () => {
  assert.throws(() => parseSearchQuery("has:video"), /has: unsupported value/);
  assert.throws(() => parseSearchQuery("mystery:value"), /Unknown search operator/);
  assert.throws(() => parseSearchQuery('subject:"unfinished'), /Unclosed quoted phrase/);
  assert.throws(() => parseSearchQuery("after:not-a-date"), /after: invalid date/);
  assert.throws(() => parseSearchQuery("larger:watts"), /larger: invalid size/);
});

test("builds bounded, owner-scoped, stable search requests", async () => {
  const result = await buildMailQuery({} as never, "owner-123", {
    folder: "inbox",
    query: 'from:alice@example.com "launch notes" -is:read',
    page: 2,
    pageSize: 80,
    sort: "oldest",
  });

  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 80);
  assert.equal(result.searchActive, true);
  assert.match(result.path, /owner_id=eq.owner-123/);
  assert.match(result.path, /search_vector=wfts\./);
  assert.match(result.path, /from_address=ilike/);
  assert.match(result.path, /is_read=eq\.false/);
  assert.match(result.path, /order=created_at\.asc,id\.asc/);
  assert.match(result.path, /offset=80&limit=81/);
});
