import test from 'node:test';
import assert from 'node:assert/strict';
import { getFundingRisk } from '../lib/fundingRisk.mjs';
test('normal funding',()=>assert.equal(getFundingRisk(0.12,8).label,'عادی'));
test('severe funding',()=>assert.equal(getFundingRisk(-2,4).level,'very-high'));
test('frequent funding',()=>assert.equal(getFundingRisk(-0.2,1).level,'high'));
test('extreme funding',()=>assert.equal(getFundingRisk(0.8,1).candidateDefaultAllowed,false));
test('missing funding',()=>assert.equal(getFundingRisk(null,8).level,'unknown'));
