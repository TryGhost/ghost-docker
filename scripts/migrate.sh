#!/usr/bin/env bash

set -euo pipefail

# Constants
readonly GHOST_UID=1000
readonly GHOST_GID=1000
readonly MYSQL_TIMEOUT=120
readonly DISK_SPACE_SAFETY_FACTOR=1.5
readonly TEMP_SQL_FILE="${PWD}/data/ghost_import.sql"
readonly RECOVERY_SCRIPT="${PWD}/recovery_instructions.sh"

# Global variables
current_location=""
mysql_user=""
mysql_password=""
ghost_service_name=""

# Function to convert bytes to human readable format
human_readable() {
    local bytes=$1
    local units=("B" "KB" "MB" "GB" "TB")
    local unit=0
    local size=$bytes

    while (( $(echo "$size > 1024" | bc -l) )) && (( unit < 4 )); do
        size=$(echo "scale=2; $size / 1024" | bc -l)
        ((unit++))
    done

    echo "${size} ${units[$unit]}"
}

# Function to get size in bytes
get_size_bytes() {
    local path=$1
    if [[ -d "$path" ]]; then
        du -sb "$path" 2>/dev/null | cut -f1
    else
        echo "0"
    fi
}

# Cleanup function
cleanup() {
    local exit_code=$?

    if [[ -f "$TEMP_SQL_FILE" ]]; then
        echo "Cleaning up temporary files..."
        rm "$TEMP_SQL_FILE"
    fi

    if [[ $exit_code -ne 0 && -f "$RECOVERY_SCRIPT" ]]; then
        echo ""
        echo "ERROR: Migration failed!"
        echo "To restore your original Ghost installation, run:"
        echo "  bash $RECOVERY_SCRIPT"
        echo ""
    fi

    exit $exit_code
}

# Set trap for cleanup
trap cleanup EXIT INT TERM

# Create recovery script
create_recovery_script() {
    cat > "$RECOVERY_SCRIPT" << EOF
#!/usr/bin/env bash
# Recovery script generated by Ghost migration on $(date)
# This script will restore your original Ghost installation

set -euo pipefail

echo "Restoring original Ghost installation..."

# Stop any Docker containers that might have been started
docker compose down 2>/dev/null || true

# Re-enable and start the original Ghost service
systemctl enable "${ghost_service_name}"
systemctl start "${ghost_service_name}"

echo "Original Ghost installation has been restored."
echo "You can check the status with: systemctl status ${ghost_service_name}"
EOF

    chmod +x "$RECOVERY_SCRIPT"
    echo "Recovery script created at: $RECOVERY_SCRIPT"
}

# Validate MySQL connection
validate_mysql_connection() {
    local host=$1
    local database=$2
    local user=$3
    local password=$4

    echo "Testing MySQL connection..."

    if mysql -h"$host" -u"$user" -p"$password" -e "SELECT 1 FROM information_schema.tables WHERE table_schema='$database' LIMIT 1;" &>/dev/null; then
        echo "✓ MySQL connection successful"
        return 0
    else
        echo "✗ MySQL connection failed"
        return 1
    fi
}

# Check prerequisites
check_prerequisites() {
    # Check we're running as root
    if [[ "$EUID" -ne 0 ]]; then
        echo "Sorry, this script must be run as root!"
        exit 1
    fi

    # Check required commands
    local required_commands=("jq" "docker" "bc" "mysql" "mysqldump" "rsync")
    local missing_commands=()

    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &>/dev/null; then
            missing_commands+=("$cmd")
        fi
    done

    if [[ ${#missing_commands[@]} -gt 0 ]]; then
        echo "The following required commands are not installed:"
        printf ' - %s\n' "${missing_commands[@]}"
        echo "Please install them first."
        exit 1
    fi
}

# Show migration summary
show_migration_summary() {
    echo "
═══════════════════════════════════════════════════════════════════
                    GHOST MIGRATION SUMMARY
═══════════════════════════════════════════════════════════════════

This script will migrate your Ghost CLI installation to Docker.

WHAT WILL HAPPEN:
  ✓ Validate MySQL credentials
  ✓ Stop your current Ghost installation
  ✓ Copy content directory to Docker mount
  ✓ Export and import your database to a Docker based MySQL instance
  ✓ Start Ghost in Docker container
  ✓ Optionally configure Caddy for HTTPS

WHAT WONT HAPPEN:
  ✓ No data will be deleted
  ✓ Recovery script will be created
  ✓ Original installation remains intact

REQUIREMENTS:
  ✓ .env file configured for Docker
  ✓ MySQL credentials with dump permissions
  ✓ Sufficient disk space for migration

═══════════════════════════════════════════════════════════════════
"
}

# Migrate content directory
migrate_content() {
    local source="${current_location}/content/"
    local dest="${PWD}/data/ghost/"

    echo "Starting content migration..."
    echo "Source: $source"
    echo "Destination: $dest"
    echo ""

    # Create destination directory
    mkdir -p "$dest"

    # Copy with progress
    rsync --info=progress2 -aHv "$source" "$dest"

    echo ""
    echo "Setting permissions for Ghost container (UID: $GHOST_UID, GID: $GHOST_GID)..."
    chown -R ${GHOST_UID}:${GHOST_GID} "$dest"

    echo "✓ Content migration completed"
}

# Export and import database
migrate_database() {
    local mysql_host
    local mysql_database
    mysql_host=$(jq -r < "${current_location}/config.production.json" '.database.connection.host')
    mysql_database=$(jq -r < "${current_location}/config.production.json" '.database.connection.database')

    echo "Exporting database from $mysql_host..."

    # Export database
    if ! mysqldump -h"$mysql_host" -u"$mysql_user" -p"$mysql_password" "$mysql_database" > "$TEMP_SQL_FILE"; then
        echo "ERROR: Failed to export database"
        exit 1
    fi

    local dump_size
    dump_size=$(human_readable "$(stat -c%s "$TEMP_SQL_FILE")")
    echo "✓ Database exported successfully ($dump_size)"

    # Start MySQL container
    echo "Starting MySQL container..."
    docker compose up db -d

    # Wait for MySQL to be ready
    echo -n "Waiting for MySQL container to be ready"
    local counter=0
    until [ "$(docker compose ps db --format json | jq -r '.Health')" = "healthy" ] || [ $counter -eq $MYSQL_TIMEOUT ]; do
        echo -n "."
        sleep 1
        ((counter++)) || true
    done

    if [[ $counter -eq $MYSQL_TIMEOUT ]]; then
        echo ""
        echo "ERROR: Timed out waiting for MySQL container"
        exit 1
    fi

    echo " ✓"

    # Import database
    echo "Importing database into Docker MySQL..."
    if ! docker compose exec -T db sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" $MYSQL_DATABASE' < "$TEMP_SQL_FILE"; then
        echo "ERROR: Failed to import database"
        exit 1
    fi

    echo "✓ Database migration completed"

    # Clean up SQL file
    rm -f "$TEMP_SQL_FILE"
}

# Main script starts here
main() {
    check_prerequisites

    echo "WARNING: This script is currently in beta, please ensure you have a backup!"

    show_migration_summary

    read -rp 'Ready to proceed with migration? (y/n): ' confirm
    if [[ "${confirm,,}" != "y" ]]; then
        echo "Migration cancelled."
        exit 0
    fi

    # Get installation location
    read -rp 'Enter your current Ghost installation path: ' current_location

    if [[ -z "$current_location" ]]; then
        echo "ERROR: Installation path is required"
        exit 1
    fi

    # Validate Ghost installation
    if [[ ! -f "${current_location}/.ghost-cli" ]]; then
        echo "ERROR: No Ghost-CLI installation found at ${current_location}"
        exit 1
    fi

    if [[ ! -d "${current_location}/content" ]]; then
        echo "ERROR: No content directory found at ${current_location}/content"
        exit 1
    fi

    # Check for .env file
    if [[ ! -f "${PWD}/.env" ]]; then
        echo "ERROR: Please create a .env file for the Docker installation first"
        exit 1
    fi

    # Get Ghost service name
    ghost_service_name="ghost_$(jq -r < "${current_location}/.ghost-cli" '.name')"

    # Get database configuration
    local mysql_host
    local mysql_database
    mysql_host=$(jq -r < "${current_location}/config.production.json" '.database.connection.host')
    mysql_database=$(jq -r < "${current_location}/config.production.json" '.database.connection.database')

    # Check disk space
    echo ""
    echo "Checking disk space requirements..."

    local content_size
    local content_size_human
    local required_space
    local required_space_human
    local available_space
    local available_space_human

    content_size=$(get_size_bytes "${current_location}/content")
    content_size_human=$(human_readable "$content_size")
    required_space=$(echo "$content_size * $DISK_SPACE_SAFETY_FACTOR" | bc | cut -d'.' -f1)
    required_space_human=$(human_readable "$required_space")
    available_space=$(df -B1 "${PWD}" | tail -1 | awk '{print $4}')
    available_space_human=$(human_readable "$available_space")

    echo "  Content size: ${content_size_human}"
    echo "  Required space: ${required_space_human}"
    echo "  Available space: ${available_space_human}"

    if (( available_space < required_space )); then
        echo ""
        echo "ERROR: Insufficient disk space!"
        echo "Need ${required_space_human} but only ${available_space_human} available."
        exit 1
    fi

    echo "✓ Disk space check passed"
    echo ""

    # Get MySQL credentials and validate
    read -rp "MySQL user for database export (default: root): " mysql_user
    mysql_user=${mysql_user:-root}

    # Get password securely
    echo -n "MySQL password for ${mysql_user}: "
    read -rs mysql_password
    echo ""

    # Validate connection
    if ! validate_mysql_connection "$mysql_host" "$mysql_database" "$mysql_user" "$mysql_password"; then
        echo "Please check your MySQL credentials and try again."
        exit 1
    fi

    # Create recovery script
    create_recovery_script

    # Final confirmation before stopping Ghost
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  YOUR SITE WILL NOW GO OFFLINE FOR MIGRATION"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "The next steps will:"
    echo "  1. Stop your Ghost service"
    echo "  2. Migrate your content and database"
    echo "     a. Your content directory will now be at ${PWD}/data/ghost/"
    echo "     b. Your MySQL database will now be at ${PWD}/data/mysql/"
    echo "  3. Start Ghost in Docker"
    echo ""
    echo "If anything goes wrong, run: bash $RECOVERY_SCRIPT"
    echo ""
    read -rp 'Continue with migration? This will take your site offline. (y/n): ' confirm

    if [[ "${confirm,,}" != "y" ]]; then
        echo "Migration cancelled."
        rm -f "$RECOVERY_SCRIPT"
        exit 0
    fi

    # Stop Ghost service
    echo ""
    echo "Stopping Ghost service..."
    systemctl stop "$ghost_service_name"
    systemctl disable "$ghost_service_name"
    echo "✓ Ghost service stopped"

    # Migrate content
    echo ""
    migrate_content

    # Migrate database
    echo ""
    migrate_database

    # Import configuration
    echo ""
    echo "Importing configuration from existing installation..."
    node "${PWD}/scripts/config-to-env.js" "${current_location}/config.production.json"

    read -rp 'Import these settings to .env? (y/n): ' confirm
    if [[ "${confirm,,}" == "y" ]]; then
        echo -e '\n# Configuration imported from existing Ghost install' >> "${PWD}/.env"
        node "${PWD}/scripts/config-to-env.js" "${current_location}/config.production.json" >> "${PWD}/.env"
        echo "✓ Configuration imported"
    else
        echo "Skipped configuration import"
        echo "Note: You'll need to manually configure mail settings if required"
    fi

    # Start Ghost
    echo ""
    echo "Starting Ghost container..."
    docker compose up ghost -d
    echo "✓ Ghost is running in Docker"

    # Caddy setup
    echo ""
    read -rp 'Start Caddy for automatic HTTPS? This will stop Nginx. (y/n): ' confirm
    if [[ "${confirm,,}" == "y" ]]; then
        echo "Stopping Nginx..."
        systemctl stop nginx || true
        systemctl disable nginx || true

        echo "Starting Caddy..."
        docker compose up caddy -d

        local domain
        domain=$(grep 'DOMAIN' "${PWD}/.env" | cut -d '=' -f 2)
        echo ""
        echo "✓ Caddy is running!"
        echo "✓ Your site is available at: https://${domain}"
    else
        echo ""
        echo "✓ Ghost is running on port 2368"
        echo "  Configure your reverse proxy to forward traffic to it"
    fi

    # Success! Remove recovery script
    rm -f "$RECOVERY_SCRIPT"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "✓ MIGRATION COMPLETED SUCCESSFULLY!"
    echo "════════════════════════════════════════════════════════════"
    echo ""
    echo "Your Ghost site is now running in Docker."
    echo "Original installation files remain at: $current_location"
    echo "Your existing MySQL instance is still running at: $mysql_host"
    echo ""
    echo "Next steps:"
    echo "  - Monitor logs: docker compose logs -f ghost"
    echo "  - View status: docker compose ps"
    echo "  - Stop services: docker compose down"
    echo ""
}

# Run main function
main "$@"
