/**
 * Tests for src/agent/tool-relevance.ts (tiered relevance-based tool gating).
 * Run: node --experimental-strip-types test/tool-relevance.test.ts
 */
import {
  selectRelevantToolNames,
  filterSchemasByRelevance,
  CORE_TOOLS,
} from '../src/agent/tool-relevance.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const ALL = [
  'read_file','write_file','edit_text','multi_edit','edit_symbol','multi_file_edit',
  'ls','glob','grep','shell','todo_write','todo_read','remember','recall','task',
  'orchestrate','gather','use_skill','search_skills','diagnostics',
  'git_status','git_commit','git_diff','git_log','git_branch','git_create_pr',
  'browser_navigate','browser_click','browser_screenshot','browser_close',
  'docker_build','docker_ps','docker_compose',
  'db_query','db_schema','dev_server_start','dev_server_stop',
  'web_search','web_fetch','tavily','http_request',
  'design_audit','detect_frontend_stack','find_ui_components','vision_analyze',
  'csv_read','xlsx_read','pdf_read','wp_find_hook','wp_list_hooks',
  'explain_codebase','find_dead_code','semantic_search','auto_fix',
  'artifact_create','artifact_update','artifact_list','artifact_get','artifact_rollback','artifact_live','artifact_live_stop',
];
const names = (sig: string) => selectRelevantToolNames(ALL, sig).selected;

console.log('— CORE always present —');
{
  const g = names('who are you?');
  check('core: read_file', g.has('read_file'));
  check('core: shell', g.has('shell'));
  check('core: use_skill', g.has('use_skill'));
  check('every existing CORE member selected', [...CORE_TOOLS].filter(t => ALL.includes(t)).every(t => g.has(t)));
}

console.log('— trivial greetings stay lean (CORE only) —');
{
  const g = selectRelevantToolNames(ALL, 'who are you?');
  check('greeting is trivial', g.trivial === true);
  check('greeting excludes git', !g.selected.has('git_status'));
  check('greeting excludes docker', !g.selected.has('docker_build'));
  check('greeting excludes frontend', !g.selected.has('design_audit'));
  check('greeting much smaller than full', g.selected.size < ALL.length * 0.5);
  check('hi/hello trivial too', selectRelevantToolNames(ALL, 'سلام').trivial === true);
}

console.log('— Persian real task gets COMMON families (the key fix) —');
{
  const hero = selectRelevantToolNames(ALL, 'باگ‌های هیرو رو پیدا کن');
  check('persian bug-find task is NOT trivial', hero.trivial === false);
  check('persian task includes git (common)', hero.selected.has('git_status'));
  check('persian task includes code-intel (common)', hero.selected.has('explain_codebase'));
  check('persian task includes frontend (common)', hero.selected.has('design_audit'));
  check('persian task includes web (common)', hero.selected.has('web_search'));
  check('persian task still EXCLUDES docker (specialist, unmentioned)', !hero.selected.has('docker_build'));
  check('persian task still EXCLUDES browser (specialist)', !hero.selected.has('browser_click'));
  check('persian task still EXCLUDES db (specialist)', !hero.selected.has('db_query'));
}

console.log('— English real task also gets COMMON —');
{
  const t = names('refactor the auth module');
  check('english task includes code-intel', t.has('semantic_search'));
  check('english task includes git', t.has('git_commit'));
  check('english task excludes docker', !t.has('docker_build'));
}

console.log('— specialist families gate on explicit signal —');
{
  check('docker keyword pulls docker', names('dockerize this and build the container').has('docker_build'));
  check('sql keyword pulls db', names('write a SQL query for postgres').has('db_query'));
  check('browser keyword pulls browser', names('take a screenshot in a headless browser').has('browser_screenshot'));
  check('wordpress keyword pulls wp', names('find the woocommerce hook').has('wp_find_hook'));
  check('.csv extension pulls data family', names('parse the data.csv file').has('csv_read'));
  check('docker NOT pulled for a plain edit task', !names('fix the typo in the readme').has('docker_build'));
}

console.log('— artifact family gates on the artifact signal (regression) —');
{
  // Regression: artifact_* matched no tier, so the gate silently never shipped
  // them and the agent never knew it could make an artifact even when asked.
  const en = names('Create a React artifact named Counter Button');
  check('english artifact task surfaces artifact_create', en.has('artifact_create'));
  check('english artifact task surfaces artifact_update', en.has('artifact_update'));
  const fa = names('یه آرتیفکت ری‌اکت بساز');
  check('persian artifact task surfaces artifact_create', fa.has('artifact_create'));
  check('non-artifact task EXCLUDES artifact tools', !names('fix the type error in math.ts').has('artifact_create'));
  // live-artifacts: a "live"/"hot-reload" request must surface the live tools.
  const live = names('start a live preview of the artifact with hot-reload');
  check('live request surfaces artifact_live', live.has('artifact_live'));
  check('live request surfaces artifact_live_stop', live.has('artifact_live_stop'));
}

console.log('— specialist composes with common —');
{
  const t = names('refactor the db layer and write a new sql query');
  check('common (codeintel) present', t.has('semantic_search'));
  check('specialist (db) present', t.has('db_query'));
  check('unrelated specialist (docker) absent', !t.has('docker_build'));
}

console.log('— schema wrapper —');
{
  const schemas = ALL.map(n => ({ type: 'function' as const, function: { name: n, description: '', parameters: {} } }));
  const greet = filterSchemasByRelevance(schemas, 'who are you?');
  check('greeting cuts schema count', greet.after < greet.before * 0.5);
  const real = filterSchemasByRelevance(schemas, 'باگ‌های هیرو رو پیدا کن');
  check('persian task keeps a healthy mid-size set', real.after > greet.after && real.after < real.before);
  check('order preserved', real.schemas.map(s => s.function.name).every((n, i, a) => i === 0 || ALL.indexOf(n) > ALL.indexOf(a[i-1])));
  check('never empty', filterSchemasByRelevance([], 'x').schemas.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
