'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseJsonp, extractJsString, extractJsArray, extractJsJson,
  toNumber, isTradingTime, jitter, randInt, clamp, round2,
} = require('../src/util');

test('parseJsonp 解析 JSONP 包裹', () => {
  const obj = { ErrCode: 0, Datas: [1, 2] };
  assert.deepEqual(parseJsonp(`cb(${JSON.stringify(obj)});`), obj);
  assert.deepEqual(parseJsonp('x({"a":1})'), { a: 1 });
  assert.deepEqual(parseJsonp('{"a":2}'), { a: 2 });
});

test('parseJsonp:纯 JSON 值含括号不被误拆(真实线上案例)', () => {
  // 东财搜索返回纯 JSON,NAME 里带 "(LOF)C" — 旧实现会在第一个 "(" 处误拆导致解析失败
  const raw = '{"ErrCode":0,"ErrMsg":"fromcache","Datas":[{"CODE":"012414","NAME":"招商中证白酒指数(LOF)C"}]}';
  const out = parseJsonp(raw);
  assert.equal(out.ErrCode, 0);
  assert.equal(out.Datas[0].NAME, '招商中证白酒指数(LOF)C');
  // 值含 "(" 与回调名同名等极端情况
  assert.deepEqual(parseJsonp('{"name":"cb(x"}'), { name: 'cb(x' });
});

test('extractJs 系列函数', () => {
  const js = `var fS_name = "测试基金A";
var stockCodes=["6005191","6008091"];
var empty=[ ];
var cfg={"a":1};
var rate="1.50";`;
  assert.equal(extractJsString(js, 'fS_name'), '测试基金A');
  assert.equal(extractJsString(js, 'rate'), '1.50');
  assert.deepEqual(extractJsArray(js, 'stockCodes'), ['6005191', '6008091']);
  assert.deepEqual(extractJsArray(js, 'empty'), []);
  assert.deepEqual(extractJsJson(js, 'cfg'), { a: 1 });
  assert.equal(extractJsString(js, 'missing'), undefined);
});

test('toNumber 边界', () => {
  assert.equal(toNumber('1.23'), 1.23);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('--'), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(null), null);
});

test('isTradingTime', () => {
  const mk = (y, mo, d, h, mi, day) => new Date(y, mo, d, h, mi);
  // 周三 10:30 开市
  assert.equal(isTradingTime(mk(2026, 8, 9, 10, 30)), true);
  // 周三 12:00 午休
  assert.equal(isTradingTime(mk(2026, 8, 9, 12, 0)), false);
  // 周三 14:00 开市
  assert.equal(isTradingTime(mk(2026, 8, 9, 14, 0)), true);
  // 周三 15:01 收市
  assert.equal(isTradingTime(mk(2026, 8, 9, 15, 1)), false);
  // 周六闭市 (2026-09-12 是周六)
  assert.equal(isTradingTime(mk(2026, 8, 12, 10, 30)), false);
  // 节假日
  assert.equal(isTradingTime(mk(2026, 8, 9, 10, 30), ['2026-09-09']), false);
});

test('jitter / randInt / clamp / round2', () => {
  const rng = () => 0.5;
  assert.equal(jitter(100, rng), 100); // 0.5+0.5=1.0 倍
  assert.equal(randInt(1, 3, () => 0.99), 3);
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(round2(1.005), 1.0); // 二进制浮点下 1.005 实际略小于 1.005
  assert.equal(round2(0.145), 0.14);
  assert.equal(round2(1.111), 1.11);
});
