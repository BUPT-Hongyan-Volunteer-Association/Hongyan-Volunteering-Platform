import { Client } from 'pg';
import { Observable, share } from 'rxjs';

// All open rosters on this API instance use one PostgreSQL listener. NOTIFY is delivered after commit.
export function rosterEvents() {
  return new Observable<string>((subscriber) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on('notification', (event) => {
      if (event.payload) subscriber.next(event.payload);
    });
    client.on('error', (error) => subscriber.error(error));
    client.on('end', () => subscriber.complete());
    void client
      .connect()
      .then(() => client.query('LISTEN registration_changed'))
      .then(
        () => subscriber.next('*'),
        (error) => subscriber.error(error),
      );
    return () => {
      void client.end().catch(() => undefined);
    };
  }).pipe(share());
}
