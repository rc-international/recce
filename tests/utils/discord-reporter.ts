import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

interface TestOutcome {
  title: string;
  status: string;
  duration: number;
  error?: string;
}

class DiscordReporter implements Reporter {
  private results: TestOutcome[] = [];
  private startTime = 0;

  onBegin(_config: FullConfig, _suite: Suite) {
    this.startTime = Date.now();
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.results.push({
      title: test.title,
      status: result.status,
      duration: result.duration,
      error:
        result.status === 'failed'
          ? result.errors.map((e) => e.message?.slice(0, 200)).join('\n')
          : undefined,
    });
  }

  async onEnd(result: FullResult) {
    if (this.results.length === 0) return;

    const webhookUrl = process.env.RECCE_DISCORD_WEBHOOK;
    if (!webhookUrl) return;

    const totalDuration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const passed = this.results.filter((r) => r.status === 'passed').length;
    const failed = this.results.filter((r) => r.status === 'failed').length;
    const skipped = this.results.filter((r) => r.status === 'skipped').length;
    const env = process.env.BASE_URL || 'https://valors.io';
    const hasRecaptcha = process.env.RECCE_RECAPTCHA !== 'false';
    const allPassed = failed === 0 && this.results.length > 0;

    const statusEmoji = allPassed ? ':white_check_mark:' : ':x:';
    const title = `${statusEmoji} Recce E2E — ${allPassed ? 'All Passed' : 'FAILURES DETECTED'}`;

    const fields = [
      { name: 'Environment', value: env, inline: true },
      { name: 'reCAPTCHA', value: hasRecaptcha ? 'Active' : 'Mocked (dev)', inline: true },
      { name: 'Duration', value: `${totalDuration}s`, inline: true },
      { name: 'Passed', value: `${passed}`, inline: true },
      { name: 'Failed', value: `${failed}`, inline: true },
      { name: 'Skipped', value: `${skipped}`, inline: true },
    ];

    // Add failure details
    const failures = this.results.filter((r) => r.status === 'failed');
    if (failures.length > 0) {
      const failureText = failures
        .map((f) => `**${f.title}**\n\`\`\`${f.error || 'No error message'}\`\`\``)
        .join('\n');
      fields.push({ name: 'Failures', value: failureText.slice(0, 1024), inline: false });
    }

    const payload = {
      username: 'Recce',
      embeds: [
        {
          title,
          color: allPassed ? 0x00ff00 : 0xff0000,
          fields,
          timestamp: new Date().toISOString(),
          footer: { text: 'Recce E2E Suite' },
        },
      ],
    };

    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        console.error(`Discord webhook failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.error('Discord webhook error:', err);
    }
  }
}

export default DiscordReporter;
