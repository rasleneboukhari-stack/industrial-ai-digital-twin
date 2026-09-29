import pandas as pd
import psycopg2


def load_telemetry(limit=10000):
    connection = psycopg2.connect(
        host="localhost",
        port=5433,
        database="factory",
        user="industrial",
        password="industrial",
    )

    query = """
            SELECT
                simulated_minute,
                machine_id,
                temperature,
                vibration,
                rpm,
                load,
                current,
                health,
                running,
                state_code
            FROM training_telemetry
            ORDER BY simulated_minute DESC, machine_id
                LIMIT %s \
            """

    df = pd.read_sql_query(
        query,
        connection,
        params=(limit,)
    )

    connection.close()

    return df


if __name__ == "__main__":
    data = load_telemetry()
    print(data.head())