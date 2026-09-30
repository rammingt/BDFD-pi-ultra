'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.LOG_LEVEL = 'error';

const { DEFAULT_SQUADS } = require('../../../src/aesu/config/index');
const { findSquad, parseSquads, SQUADS, squadFromRoles, squadRoleChange, squadRoleIds } = require('../../../src/aesu/squads/types');

const ALPHA = '1545916753387851916';
const AETRU = '1546472653077086278';
const ONE_SAL = '1491712259695706163';
const TWO_ICU = '1491712329723936828';

describe('parseSquads', () => {
  it('reads the seven squads out of the default list', () => {
    const squads = parseSquads(DEFAULT_SQUADS, '1SAL');

    assert.deepEqual(
      squads.map((squad) => squad.label),
      ['Alpha', 'Beta', 'Charlie', 'Delta', 'Epsilon', 'AETRU', '1SAL'],
    );
    assert.equal(squads[0]?.roleId, ALPHA);
    assert.equal(squads.at(-1)?.roleId, ONE_SAL);
  });

  it('gives every squad but 1SAL the shared role', () => {
    const squads = parseSquads(DEFAULT_SQUADS, '1SAL');

    assert.deepEqual(
      squads.filter((squad) => !squad.shared).map((squad) => squad.label),
      ['1SAL'],
    );
    assert.equal(squads.filter((squad) => squad.shared).length, 6);
  });

  it('keys a label that starts with a digit rather than dropping it', () => {
    assert.equal(parseSquads('1SAL=' + ONE_SAL)[0]?.key, '1sal');
  });

  it('drops an entry whose role id is not a snowflake', () => {
    assert.deepEqual(parseSquads('Alpha=nonsense, Beta=' + ALPHA).map((s) => s.label), ['Beta']);
    assert.deepEqual(parseSquads('Alpha'), [], 'no role id at all');
  });

  it('keeps the first of two entries with the same name', () => {
    const squads = parseSquads(`Alpha=${ALPHA}, Alpha=${AETRU}`);
    assert.equal(squads.length, 1);
    assert.equal(squads[0]?.roleId, ALPHA);
  });
});

describe('squadRoleChange', () => {
  const alpha = findSquad('Alpha');
  const sal = findSquad('1SAL');

  it('gives an ordinary squad its own role and 2ICU', () => {
    const { wanted, unwanted } = squadRoleChange(alpha);

    assert.deepEqual(wanted, [ALPHA, TWO_ICU]);
    assert.ok(!unwanted.includes(TWO_ICU), 'the shared role is not removed again');
    assert.ok(unwanted.includes(ONE_SAL), 'every other squad role comes off');
  });

  it('gives 1SAL its own role only, and takes 2ICU off', () => {
    const { wanted, unwanted } = squadRoleChange(sal);

    assert.deepEqual(wanted, [ONE_SAL]);
    assert.ok(
      unwanted.includes(TWO_ICU),
      'somebody moved from Alpha to 1SAL must lose 2ICU, or they keep a role they should not have',
    );
  });

  it('clears everything when nobody is in a squad', () => {
    const { wanted, unwanted } = squadRoleChange(null);

    assert.deepEqual(wanted, []);
    assert.deepEqual([...unwanted].sort(), [...squadRoleIds()].sort());
  });
});

describe('findSquad', () => {
  it('matches a label, a key or a role id, however it is written', () => {
    assert.equal(findSquad('Alpha')?.key, 'alpha');
    assert.equal(findSquad('alpha')?.key, 'alpha');
    assert.equal(findSquad('  AETRU  ')?.key, 'aetru');
    assert.equal(findSquad('aetru')?.label, 'AETRU');
    assert.equal(findSquad(ONE_SAL)?.label, '1SAL');
  });

  it('is null for something that is not a squad', () => {
    assert.equal(findSquad('Zulu'), null);
    assert.equal(findSquad(''), null);
  });
});

describe('squadFromRoles', () => {
  it('reads the squad off whatever roles somebody holds', () => {
    assert.equal(squadFromRoles(['some-other-role', ALPHA])?.label, 'Alpha');
    assert.equal(squadFromRoles([TWO_ICU]), null, '2ICU on its own is not a squad');
    assert.equal(squadFromRoles([]), null);
  });
});

describe('the configured squads', () => {
  it('are the seven the server actually has', () => {
    assert.equal(SQUADS.length, 7);
    assert.ok(squadRoleIds().includes(TWO_ICU), '2ICU is managed alongside them');
    assert.equal(squadRoleIds().length, 8);
  });
});
