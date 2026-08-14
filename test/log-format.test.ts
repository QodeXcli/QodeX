import { formatLogLine } from '../src/utils/log-format';

describe('formatLogLine', () => {
  it('should format a log line with level and message', () => {
    const result = formatLogLine('info', 'hello');
    expect(result).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] hello/);
  });

  it('should format a log line with extra fields', () => {
    const result = formatLogLine('warn', 'something happened', { user: 'testuser', id: 123 });
    expect(result).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[WARN\] something happened user=testuser id=123/);
  });

  it('should handle empty extra fields', () => {
    const result = formatLogLine('debug', 'detailed info', {});
    expect(result).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[DEBUG\] detailed info/);
  });

  it('should handle different log levels', () => {
    const result = formatLogLine('error', 'critical failure');
    expect(result).toBe('[ERROR] critical failure');
  });

  it('should handle extra fields with various types', () => {
    const result = formatLogLine('info', 'data', { success: true, value: 10.5 });
    expect(result).toBe('[INFO] data success=true value=10.5');
  });
});
