import { readSSE } from './sse.js';
import { metricSummary } from './metric-summary.js';

const $ = (id) => document.getElementById(id);
const stageInfo = {
  source: ['Fetch repository', 'Pinning the repository revision and reading project documents.'],
  metrics: ['Identify claims', 'Extracting measurable claims from the README.'],
  plan: ['Design experiments', 'Evaluating evidence and designing feasible experiments.'],
  online: ['Find additional sources', 'Searching for relevant public sources.'],
  sandbox: ['Inspect evidence', 'Reading selected evidence in an isolated environment.'],
  benchmark: ['Run experiments', 'Running experiments and recording any blockers.'],
  assessment: ['Prepare findings', 'Separating claims, observations, and unresolved questions.'],
};
const statuses = { evidence_only: 'Evidence only', unsupported: 'Unsupported', inconclusive: 'Inconclusive' };
const runStatuses = { measured: 'Measured', running: 'Running', not_runnable: 'Not runnable', not_executed: 'Not executed', interrupted: 'Interrupted', failed: 'Execution failed', unavailable: 'Environment unavailable', invalid_output: 'Invalid output', retrying: 'Repairing and retrying' };
const state = { controller: null, running: false, completed: false, partial: false, cancelled: false, sessionId: '', current: '', stages: [], details: {}, runs: [], claims: [], report: null, reportUrl: '', error: '' };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function validRepository(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && parts.length === 2 && parts.every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
      && !!parts[1].replace(/\.git$/i, '');
  } catch { return false; }
}

function validReportUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.search || url.hash || !/^\/investigations\/[0-9a-f-]{36}$/i.test(url.pathname)) return '';
    return url.pathname;
  } catch { return ''; }
}

function list(items) {
  if (!items.length) return null;
  const ul = node('ul', 'detail-list');
  for (const item of items) ul.append(node('li', '', item));
  return ul;
}

function stageDetails(stage) {
  const data = state.details[stage];
  if (!data || typeof data !== 'object') return [];
  if (stage === 'source') return [data.revision ? `Revision ${String(data.revision).slice(0, 12)}` : '',
    Array.isArray(data.documents) ? `Read ${data.documents.length} project documents` : ''].filter(Boolean);
  if (stage === 'metrics') return [Array.isArray(data.claims) ? `Identified ${data.claims.length} claims` : ''].filter(Boolean);
  if (stage === 'plan') return [Array.isArray(data.experiments) ? `Prepared ${data.experiments.length} experiment plans` : 'Plan prepared'];
  if (stage === 'online') return [Array.isArray(data.searches) && data.searches.length ? `Search: ${[...new Set(data.searches.map((item) => item.query).filter(Boolean))].join('; ')}` : '',
    ...(Array.isArray(data.sources) ? data.sources.map((item) => `Source: ${item.title || item.url}`) : []),
    ...(Array.isArray(data.errors) ? data.errors.map((item) => `Search notice: ${item.error}`) : [])].filter(Boolean);
  if (stage === 'sandbox') {
    const observations = Array.isArray(data.observations) ? data.observations : [];
    return [observations.length ? `Checked ${observations.length} evidence items` : 'No evidence to check',
      ...observations.filter((item) => item.error).map((item) => `${item.path}: ${item.error}`)];
  }
  if (stage === 'benchmark') return state.runs.map((item) => {
    const measurement = typeof item.actual === 'number' ? ` · ${item.actual}${item.unit ? ` ${item.unit}` : ''}` : '';
    return `${item.claimId} · ${runStatuses[item.status] || item.status}${measurement}${item.reason || item.error ? ` · ${item.reason || item.error}` : ''}`;
  });
  if (stage === 'assessment') return [data.summary].filter(Boolean);
  return [];
}

function renderTimeline() {
  const scroller = $('feed-scroll');
  const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const timeline = $('timeline');
  timeline.replaceChildren();
  $('feed-empty').hidden = state.stages.length > 0 || !!state.error;
  state.stages.forEach((stage, index) => {
    const current = stage === state.current;
    const kind = current && (state.error || state.cancelled || state.partial) ? 'failed' : current && state.running && !state.completed ? 'active' : 'done';
    const li = node('li', `timeline-item ${kind}`);
    const marker = node('span', `timeline-marker${kind === 'active' ? ' spinner' : ''}`, kind === 'done' ? '✓' : kind === 'failed' ? '!' : kind === 'active' ? '' : String(index + 1).padStart(2, '0'));
    marker.setAttribute('aria-hidden', 'true');
    const content = node('div');
    const header = node('div', 'timeline-header');
    header.append(node('p', 'timeline-title', stageInfo[stage]?.[0] || stage), node('span', 'timeline-state',
      kind === 'active' ? 'In progress' : kind === 'failed' ? (state.cancelled ? 'Stopped' : state.partial ? 'Timed out' : 'Incomplete') : 'Completed'));
    content.append(header);
    const description = stageInfo[stage]?.[1];
    if (description && kind === 'active') content.append(node('p', 'timeline-description', description));
    const detailList = list(stageDetails(stage));
    if (detailList) content.append(detailList);
    li.append(marker, content);
    timeline.append(li);
  });
  $('feed-label').textContent = state.partial ? 'Timed out' : state.running ? 'Live' : state.completed ? 'Completed' : state.cancelled ? 'Stopped' : state.error ? 'Incomplete' : 'Waiting to start';
  $('run-error').hidden = !state.error;
  $('run-error').textContent = state.error;
  if (follow) scroller.scrollTop = scroller.scrollHeight;
}

function resultItem(label, text, extra) {
  const item = node('div', 'result-item');
  if (label) item.append(node('span', 'result-item-label', label));
  if (text) item.append(node('p', 'result-item-text', text));
  if (extra) item.append(node('p', 'result-item-extra', extra));
  return item;
}

function renderResultCard(stage) {
  const titles = { source: ['01', 'Repository'], metrics: ['02', 'Identified claims'], plan: ['03', 'Experiment plan'],
    online: ['↗', 'Additional sources'], sandbox: ['04', 'Sandbox evidence checks'], benchmark: ['05', 'Experiment results'] };
  if (!titles[stage] || !state.details[stage]) return;
  const cards = $('result-cards');
  let card = [...cards.children].find((element) => element.dataset.stage === stage);
  if (!card) {
    card = node('article', 'result-card');
    card.dataset.stage = stage;
    cards.append(card);
  }
  card.replaceChildren();
  const [number, title] = titles[stage];
  const header = node('div', 'result-card-header');
  header.append(node('span', 'result-card-number', number), node('h4', 'result-card-title', title));
  card.append(header);
  const data = state.details[stage];
  if (stage === 'source') {
    card.append(resultItem('Revision', data.revision || 'Not available', Array.isArray(data.documents) ? `Read: ${data.documents.join(', ')}` : ''));
  } else if (stage === 'metrics') {
    if (data.summary) card.append(node('p', 'result-summary', data.summary));
    for (const claim of state.claims) card.append(resultItem(claim.id || 'Claim', claim.claim || 'Untitled claim',
      [claim.sourcePath && `Source: ${claim.sourcePath}`, claim.sourceMatched === false && 'Source quote not verified'].filter(Boolean).join(' · ')));
    if (!state.claims.length) card.append(node('p', 'muted-placeholder', 'No measurable claims identified.'));
  } else if (stage === 'plan') {
    if (data.assessment) card.append(node('p', 'result-summary', data.assessment));
    for (const experiment of data.experiments || []) {
      card.append(resultItem(experiment.claimId || 'Experiment plan', experiment.method || experiment.reproduction || 'Plan recorded',
        experiment.blockedReason ? `Not runnable: ${experiment.blockedReason}` : experiment.reproduction));
    }
  } else if (stage === 'online') {
    const queries = [...new Set((data.searches || []).map((item) => item.query).filter(Boolean))];
    if (queries.length) card.append(resultItem('Search terms', queries.join('; ')));
    for (const source of data.sources || []) {
      const item = resultItem(source.claimId || 'Public source', source.title || source.url);
      try {
        const url = new URL(source.url);
        if (['http:', 'https:'].includes(url.protocol)) {
          const link = node('a', 'source-link', url.href);
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          item.append(link);
        }
      } catch { /* ignore invalid external URLs */ }
      card.append(item);
    }
    for (const error of data.errors || []) card.append(resultItem('Search notice', error.error));
    if (!(data.sources || []).length) card.append(node('p', 'muted-placeholder', 'No usable additional sources were found.'));
  } else if (stage === 'sandbox') {
    for (const observation of data.observations || []) card.append(resultItem(observation.claimId || 'Evidence', observation.path,
      observation.error ? `Read failed: ${observation.error}` : 'Read-only evidence check completed'));
    if (!(data.observations || []).length) card.append(node('p', 'muted-placeholder', 'No evidence to check.'));
  } else {
    for (const run of state.runs) {
      const value = typeof run.actual === 'number' ? `${run.actual}${run.unit ? ` ${run.unit}` : ''}` : '';
      const result = [runStatuses[run.status] || run.status, value].filter(Boolean).join(' · ');
      const metric = run.metric || run.benchmark?.metric;
      const extra = [metric && `Metric: ${metric}`, run.reason || run.error, run.retryError && `Retry not performed: ${run.retryError}`,
        (run.attempts?.length || run.attemptsCount) > 1 && 'Retried once',
        run.matched === true ? 'Met the experiment threshold' : run.matched === false ? 'Did not meet the experiment threshold' : ''].filter(Boolean).join(' · ');
      const item = resultItem(run.claimId || 'Experiment', result, extra);
      if (Array.isArray(run.progress) && run.progress.length) {
        const progress = node('details', 'run-log');
        progress.append(node('summary', '', `View ${run.progress.length} unverified sample records`));
        for (const sample of run.progress) progress.append(node('pre', '', JSON.stringify(sample, null, 2)));
        item.append(progress);
      }
      const attempts = Array.isArray(run.attempts) ? run.attempts.map((attempt) => attempt.result) : [run];
      if (attempts.some((attempt) => attempt.stderr || attempt.stdout || attempt.error)) {
        const details = node('details', 'run-log');
        details.append(node('summary', '', 'View execution output'));
        attempts.forEach((attempt, index) => {
          const output = [attempt.error, attempt.stderr && `Execution log\n${attempt.stderr}`, attempt.stdout && `Measurement output\n${attempt.stdout}`].filter(Boolean).join('\n\n');
          if (output) details.append(node('pre', '', `Attempt ${index + 1} · ${runStatuses[attempt.status] || attempt.status}\n${output}`));
        });
        item.append(details);
      }
      card.append(item);
    }
  }
  $('results-empty').hidden = true;
}

function renderReport() {
  const report = state.report;
  const scroll = $('results-scroll');
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const wasHidden = $('report-panel').hidden;
  $('report-panel').hidden = !report;
  if (!report) return;
  $('report-title').textContent = report.partial ? 'Partial investigation report' : 'Investigation report';
  $('report-summary').textContent = report.modelSummary || report.summary || 'The investigation has ended.';
  $('report-limitation').textContent = report.limitation || '';
  $('report-link').href = state.reportUrl;
  $('report-link').hidden = !state.reportUrl;
  const container = $('findings');
  container.replaceChildren();
  const findings = metricSummary(report);
  for (const { finding, claim, run, sample } of findings) {
    const row = node('article', 'finding');
    const status = node('span', 'finding-status', statuses[finding.status] || 'Inconclusive');
    status.dataset.status = finding.status || 'inconclusive';
    const body = node('div');
    body.append(node('h4', 'finding-title', claim?.claim || finding.claimId || 'Finding'));
    if (run) {
      const measured = run.status === 'measured' && typeof run.actual === 'number' && Number.isFinite(run.actual)
        ? `: ${run.actual}${run.benchmark?.unit ? ` ${run.benchmark.unit}` : ''}` : '';
      const metric = run.benchmark?.metric ? ` · ${run.benchmark.metric}` : '';
      const threshold = run.status === 'measured' && run.matched === true ? ' · Met experiment threshold' :
        run.status === 'measured' && run.matched === false ? ' · Did not meet experiment threshold' : '';
      body.append(node('p', 'finding-metric', `${runStatuses[run.status] || run.status}${measured}${metric}${threshold}`));
      if (sample) body.append(node('p', 'finding-next', sample));
      if (run.status !== 'measured' && (run.reason || run.error)) body.append(node('p', 'finding-next', run.reason || run.error));
    }
    if (finding.explanation) body.append(node('p', 'finding-explanation', finding.explanation));
    if (finding.nextStep) body.append(node('p', 'finding-next', `Next step: ${finding.nextStep}`));
    row.append(status, body);
    container.append(row);
  }
  if (!findings.length) container.append(node('p', 'muted-placeholder', 'No individual findings are available.'));
  if (follow && wasHidden) scroll.scrollTop += $('report-panel').getBoundingClientRect().top - scroll.getBoundingClientRect().top;
}

function render() {
  $('submit-button').disabled = state.running;
  $('submit-button').firstElementChild.textContent = state.running ? 'Running...' : 'Start';
  $('repo-url').readOnly = state.running;
  $('stop-button').hidden = !state.running;
  $('run-status').dataset.state = state.error || state.cancelled || state.partial ? 'error' : state.completed ? 'done' : 'running';
  $('run-status-text').textContent = state.partial ? 'Timed out · partial report' : state.running ? 'Investigation in progress' : state.completed ? 'Investigation complete' : state.cancelled ? 'Investigation stopped' : state.error ? 'Investigation incomplete' : 'Preparing';
  document.querySelector('.workspace-heading h2').firstChild.textContent = state.partial ? 'Investigation timed out' : state.completed ? 'Investigation complete' : state.cancelled ? 'Investigation stopped' : state.error ? 'Investigation incomplete' : 'Investigation in progress';
  renderTimeline();
  renderReport();
  $('results-label').textContent = state.partial ? 'Partial report' : state.running ? 'Live' : state.completed ? 'Completed' : state.cancelled ? 'Stopped' : state.error ? 'Incomplete' : 'Waiting for results';
}

function onEvent({ event, data }) {
  let payload;
  try { payload = JSON.parse(data); } catch { throw new Error('The server returned an unreadable event.'); }
  if (!payload || typeof payload !== 'object') throw new Error('The server returned an invalid event.');
  if (event === 'start') state.sessionId = String(payload.sessionId || '');
  if (event === 'progress' && typeof payload.stage === 'string') {
    state.current = payload.stage;
    if (!state.stages.includes(payload.stage)) state.stages.push(payload.stage);
  }
  if (event === 'detail' && typeof payload.stage === 'string' && payload.data && typeof payload.data === 'object') {
    state.details[payload.stage] = payload.data;
    if (payload.stage === 'metrics' && Array.isArray(payload.data.claims)) state.claims = payload.data.claims;
    if (payload.stage === 'benchmark') {
      const index = state.runs.findIndex((run) => run.claimId === payload.data.claimId);
      if (index < 0) state.runs.push(payload.data);
      else state.runs[index] = payload.data;
    }
  }
  if (event === 'message' && typeof payload.text === 'string') state.summary = payload.text;
  if (event === 'done') {
    state.completed = true;
    state.partial = payload.partial === true;
    state.summary = payload.finalResponse || state.summary;
    state.reportUrl = validReportUrl(payload.reportUrl);
  }
  if (event === 'error') state.error = typeof payload.message === 'string' ? payload.message : 'The investigation failed. Please try again.';
  render();
  if (event === 'detail' && typeof payload.stage === 'string') renderResultCard(payload.stage);
}

async function startInvestigation(url) {
  const controller = new AbortController();
  Object.assign(state, { controller, running: true, completed: false, partial: false, cancelled: false, sessionId: '', current: '', stages: [], details: {}, runs: [], claims: [], report: null, reportUrl: '', error: '', summary: '' });
  $('page').classList.add('active');
  document.querySelector('.topbar').append($('url-form'));
  $('investigation').hidden = false;
  $('result-cards').replaceChildren();
  $('results-empty').hidden = false;
  $('repo-name').textContent = new URL(url).pathname.split('/').filter(Boolean).join(' / ').replace(/\.git$/i, '');
  $('repo-display').textContent = url;
  render();
  try {
    const response = await fetch('/investigations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: controller.signal });
    if (!response.ok) {
      let message = 'Unable to start the investigation. Check the server and try again.';
      try { message = (await response.json()).message || message; } catch { /* retain the generic error */ }
      throw new Error(message);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('The server did not return a live event stream.');
    await readSSE(response, onEvent);
    if (state.error) throw new Error(state.error);
    if (!state.completed) throw new Error('The connection ended before the investigation completed.');
    if (!state.reportUrl) throw new Error('The investigation completed, but the report URL is invalid.');
    try {
      const report = await fetch(state.reportUrl, { signal: controller.signal });
      if (!report.ok) throw new Error('The report request failed.');
      const value = await report.json();
      if (!value || typeof value !== 'object' || !Array.isArray(value.findings)) throw new Error('The report is invalid.');
      state.report = value;
      if (Array.isArray(value.metrics?.claims)) state.claims = value.metrics.claims;
      if (Array.isArray(value.benchmark?.runs)) {
        state.runs = value.benchmark.runs.map((run) => ({ ...run, metric: run.benchmark?.metric, unit: run.benchmark?.unit }));
        if (state.runs.length && !state.details.benchmark) state.details.benchmark = {};
        renderResultCard('benchmark');
      }
    } catch (error) {
      if (controller.signal.aborted) throw error;
      state.report = { summary: state.summary || 'The investigation is complete.', findings: [], limitation: 'The report could not be loaded. Use the full report link to try again.' };
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (!state.completed) state.cancelled = true;
      else state.error = 'Report loading was interrupted.';
    } else state.error = error instanceof Error ? error.message : 'The investigation failed. Please try again.';
  } finally {
    if (state.controller === controller) {
      state.running = false;
      state.controller = null;
      render();
    }
  }
}

$('url-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.running) return;
  const url = $('repo-url').value.trim();
  const valid = validRepository(url);
  $('input-shell').classList.toggle('invalid', !valid);
  $('repo-url').setAttribute('aria-invalid', String(!valid));
  $('input-error').textContent = valid ? '' : 'Enter a valid GitHub repository URL.';
  if (!valid) { $('repo-url').focus(); return; }
  void startInvestigation(url);
});
$('repo-url').addEventListener('input', () => {
  $('input-shell').classList.remove('invalid');
  $('repo-url').removeAttribute('aria-invalid');
  $('input-error').textContent = '';
});
$('stop-button').addEventListener('click', () => state.controller?.abort());

const savedReportUrl = validReportUrl(new URLSearchParams(location.search).get('report'));
if (savedReportUrl) {
  void (async () => {
    $('page').classList.add('active');
    document.querySelector('.topbar').append($('url-form'));
    $('investigation').hidden = false;
    try {
      const response = await fetch(savedReportUrl);
      if (!response.ok) throw new Error('Could not load the report.');
      const report = await response.json();
      if (!Array.isArray(report.findings)) throw new Error('The report is not complete.');
      Object.assign(state, { report, reportUrl: savedReportUrl, completed: true, partial: report.partial === true,
        claims: Array.isArray(report.metrics?.claims) ? report.metrics.claims : [],
        runs: Array.isArray(report.benchmark?.runs) ? report.benchmark.runs : [] });
      const url = report.source?.url || '';
      $('repo-name').textContent = validRepository(url) ? new URL(url).pathname.slice(1).replace(/\.git$/i, '') : 'Saved investigation';
      $('repo-display').textContent = url;
      if (state.runs.length) { state.details.benchmark = {}; renderResultCard('benchmark'); }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Could not load the report.';
    }
    render();
  })();
}
