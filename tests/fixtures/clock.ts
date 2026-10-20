export class ManualClock {
  private elapsed = 0;
  private readonly tasks: { deadline: number; callback: () => void; cancelled: boolean; fired: boolean }[] = [];

  now = () => this.elapsed;
  utc = () => new Date(Date.parse("2026-10-19T09:00:00.000Z") + this.elapsed).toISOString();

  schedule = (deadline: number, callback: () => void): (() => void) => {
    const task = { deadline, callback, cancelled: false, fired: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };

  advance(milliseconds: number): void {
    this.elapsed += milliseconds;
    for (const task of this.tasks) {
      if (!task.cancelled && !task.fired && task.deadline <= this.elapsed) {
        task.fired = true;
        task.callback();
      }
    }
  }

  fireCapturedTimer(index: number): void {
    this.tasks[index]?.callback();
  }
}
