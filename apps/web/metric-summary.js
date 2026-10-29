export function metricSummary(report) {
  const claims = Array.isArray(report.metrics?.claims) ? report.metrics.claims : [];
  const runs = Array.isArray(report.benchmark?.runs) ? report.benchmark.runs : [];
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return findings.map((finding) => {
    const claim = claims.find((item) => item.id === finding.claimId);
    const run = runs.find((item) => item.claimId === finding.claimId);
    let sample = '';
    if (run?.status === 'measured' && typeof run.stdout === 'string') {
      try {
        const output = JSON.parse(run.stdout);
        if (Number.isInteger(output.requested) && output.requested >= 0 && Number.isInteger(output.completed)
          && output.completed >= 0 && output.completed <= output.requested) {
          sample = `${output.completed} / ${output.requested} samples completed (reported by experiment)`;
        }
      } catch { /* Output may not include sample counts. */ }
    }
    return { finding, claim, run, sample };
  });
}
