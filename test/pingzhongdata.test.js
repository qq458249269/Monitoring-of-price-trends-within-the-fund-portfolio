'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseHolderStructure, parseAssetAllocation } = require('../src/sources/eastmoney');

/* 用线上抓取的真实 pingzhongdata 片段做回归样本 */
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pingzhongdata-fragments.json'), 'utf8'));

test('parseHolderStructure:真实 {series,categories} 结构', () => {
  const rows = parseHolderStructure(fixture.holderStructure);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].term, '2024-12-31');
  assert.ok(Math.abs(rows[0].orgPct - 2.09) < 1e-9);
  assert.ok(Math.abs(rows[0].individualPct - 97.91) < 1e-9);
});

test('parseHolderStructure:空/异常输入', () => {
  assert.deepEqual(parseHolderStructure(null), []);
  assert.deepEqual(parseHolderStructure({}), []);
  assert.deepEqual(parseHolderStructure({ series: [{ name: 'x', data: [1] }], categories: ['a'] }), []);
});

test('parseAssetAllocation:取最近一期', () => {
  const a = parseAssetAllocation(fixture.assetAllocation);
  assert.equal(a.date, '2026-06-30');
  assert.ok(Math.abs(a.stock - 94.79) < 1e-9);
  assert.ok(Math.abs(a.bond - 0.0) < 1e-9);
});

test('parseAssetAllocation:空输入 → null', () => {
  assert.equal(parseAssetAllocation(null), null);
  assert.equal(parseAssetAllocation({ series: [] }), null);
});
