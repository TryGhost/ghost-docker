#!/bin/bash

set -e
set -u

IFS=',' read -ra DBS <<< "$MULTIPLE_DATABASES"
  for db in "${DBS[@]}"; do
    echo "Creating database: $db"
    mariadb -u root -p"$MARIADB_ROOT_PASSWORD" <<-EOSQL
      CREATE DATABASE IF NOT EXISTS \`$db\`;
      GRANT ALL ON \`$db\`.* TO '$MARIADB_USER'@'%';
EOSQL
  done

  echo "Multiple databases created"
fi
