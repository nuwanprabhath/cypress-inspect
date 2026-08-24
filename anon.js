const B = '/Users/nuwan/projects/pet-projects/cypress-inspect/src/';
const { CloudCdp } = require(B + 'cloud-cdp');
const run = require(B + 'cloud-run');
const probe = require(B + 'cloud-probe');
const fs = require('fs');
const S = '/private/tmp/claude-501/-Users-nuwan-projects-pet-projects/62bb169b-30fc-4014-8060-404cee641d29/scratchpad';
(async () => {
  const cdp = new CloudCdp(9555);
  try {
    const r = await run.openRun(cdp, 'https://cloud.cypress.io/projects/6b9ofw/runs/13206');
    console.log('openRun ->', JSON.stringify(r).slice(0,400));
    const info = await cdp.evaluate(`(() => ({ url: location.href, title: document.title, text: (document.body&&document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300) }))()`);
    console.log('page ->', JSON.stringify(info, null, 1));
    const shot = await cdp.screenshot();
    fs.writeFileSync(S + '/anon.png', Buffer.from(shot,'base64'));
    console.log('shot bytes', Buffer.from(shot,'base64').length);
  } catch (e) { console.error('ERR', e.message); } finally { await cdp.close(); }
})();
