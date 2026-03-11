import os

import django

# Set the default Django settings module
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "attendee.settings.test")

# Initialize Django (this is required before accessing settings)
django.setup()

import psycopg2
from django.conf import settings
from django.core.management.base import BaseCommand
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT


class Command(BaseCommand):
    help = "Sets up test database and user if they do not already exist"

    def handle(self, *args, **options):
        """Setup test database and user if they do not already exist"""

        # Default connection parameters
        db_host = settings.DATABASES["default"]["HOST"]
        db_port = settings.DATABASES["default"]["PORT"]
        db_name = settings.DATABASES["default"]["NAME"]
        db_user = settings.DATABASES["default"]["USER"]
        db_password = settings.DATABASES["default"]["PASSWORD"]
        postgres_user = os.environ.get("POSTGRES_USER", "attendee_development_user")
        postgres_password = os.environ.get("POSTGRES_PASSWORD", "attendee_development_user")

        # Connect to the default postgres database
        try:
            conn = psycopg2.connect(host=db_host, port=db_port, database=os.environ.get("POSTGRES_DB", "attendee_development"), user=postgres_user, password=postgres_password)

            # Set isolation level to autocommit for database creation
            conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)

            # Create a cursor
            cursor = conn.cursor()

            print("Checking if database and user already exist...")

            # Check if user exists
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (db_user,))
            user_exists = cursor.fetchone() is not None

            # Create user if it doesn't exist
            if not user_exists:
                print(f"Creating user {db_user}...")
                cursor.execute(sql.SQL("CREATE USER {} WITH PASSWORD %s").format(sql.Identifier(db_user)), (db_password,))
                print(f"Granting createdb permission to {db_user}...")
                cursor.execute(sql.SQL("ALTER USER {} WITH CREATEDB").format(sql.Identifier(db_user)))
            else:
                print(f"User {db_user} already exists. Skipping user creation.")

            # Check if database exists
            cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
            db_exists = cursor.fetchone() is not None

            # Create database if it doesn't exist
            if not db_exists:
                print(f"Creating database {db_name}...")
                cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name)))

                print(f"Setting database owner to {db_user}...")
                cursor.execute(sql.SQL("ALTER DATABASE {} OWNER TO {}").format(sql.Identifier(db_name), sql.Identifier(db_user)))
            else:
                print(f"Database {db_name} already exists. Skipping database creation.")

            # Grant privileges on database
            print(f"Granting privileges to {db_user}...")
            cursor.execute(sql.SQL("GRANT ALL PRIVILEGES ON DATABASE {} TO {}").format(sql.Identifier(db_name), sql.Identifier(db_user)))

            # Connect to the specific database to grant privileges on schema objects
            cursor.close()
            conn.close()

            # Connect to the test database to set up schema privileges
            conn = psycopg2.connect(host=db_host, port=db_port, database=db_name, user=postgres_user, password=postgres_password)
            conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
            cursor = conn.cursor()

            # Grant schema privileges
            cursor.execute(sql.SQL("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO {}").format(sql.Identifier(db_user)))
            cursor.execute(sql.SQL("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO {}").format(sql.Identifier(db_user)))
            cursor.execute(sql.SQL("GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO {}").format(sql.Identifier(db_user)))

            print("Database setup completed successfully!")

        except Exception as e:
            print(f"Error: {str(e)}")
            raise
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
