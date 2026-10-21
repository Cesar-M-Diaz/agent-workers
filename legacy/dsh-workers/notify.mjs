const lines = [
  'dsh-workers was renamed to agent-workers.',
  'Remove this plugin and install the new one:',
  '  /plugin uninstall dsh-workers',
  '  /plugin install agent-workers@agent-workers',
  'Set backend = dsh or pi in the new plugin settings.',
  '',
];
process.stdout.write(lines.join('\n'));
