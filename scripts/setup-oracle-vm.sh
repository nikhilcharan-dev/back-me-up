#!/usr/bin/env bash
# ==============================================================================
# Oracle Cloud Infrastructure (OCI) Bare VM Setup Script for back-me-up
#
# Mounts Block Volume: /dev/oracleoci/oraclevdb -> /mnt/back-me-up-storage
# App Directory:       /var/www/back-me-up
# ==============================================================================

set -euo pipefail

MOUNT_POINT="/mnt/back-me-up-storage"
APP_DIR="/var/www/back-me-up"

# Auto-detect secondary block device (OCI symlink, /dev/sdb, /dev/vdb, or non-root disk)
BLOCK_DEVICE=""
for dev in "/dev/oracleoci/oraclevdb" "/dev/sdb" "/dev/vdb" "/dev/sdc" "/dev/nvme1n1"; do
  if [ -b "$dev" ]; then
    BLOCK_DEVICE="$dev"
    break
  fi
done

if [ -z "$BLOCK_DEVICE" ]; then
  # Exclude root system drives (sda, nvme0n1)
  DETECTED=$(lsblk -dn -o NAME,TYPE | awk '$1 !~ /^(sda|nvme0n1)$/ && $2=="disk" {print "/dev/"$1}' | head -n1)
  if [ -n "$DETECTED" ] && [ -b "$DETECTED" ]; then
    BLOCK_DEVICE="$DETECTED"
  fi
fi

echo "===> 2. Formatting & Mounting OCI Block Volume..."
# Check if block device exists
if [ -n "$BLOCK_DEVICE" ] && [ -b "$BLOCK_DEVICE" ]; then
  echo "Found block device at $BLOCK_DEVICE"
  
  # Format with ext4 if not already formatted
  if ! sudo blkid "$BLOCK_DEVICE" | grep -q "TYPE="; then
    echo "Formatting $BLOCK_DEVICE with ext4..."
    sudo mkfs.ext4 -F "$BLOCK_DEVICE"
  else
    echo "$BLOCK_DEVICE is already formatted."
  fi

  # Create mount directory
  sudo mkdir -p "$MOUNT_POINT"

  # Mount the volume
  if ! mountpoint -q "$MOUNT_POINT"; then
    echo "Mounting $BLOCK_DEVICE to $MOUNT_POINT..."
    sudo mount "$BLOCK_DEVICE" "$MOUNT_POINT"
  fi

  # Ensure persistent mount across reboots via fstab
  UUID=$(sudo blkid -s UUID -o value "$BLOCK_DEVICE")
  if ! grep -q "$UUID" /etc/fstab; then
    echo "Adding $UUID to /etc/fstab for auto-mount on boot..."
    echo "UUID=$UUID $MOUNT_POINT ext4 defaults,_netdev,nofail 0 2" | sudo tee -a /etc/fstab
  fi

  sudo chown -R $USER:$USER "$MOUNT_POINT"
else
  echo "WARNING: Device $BLOCK_DEVICE not found. Make sure the OCI block volume is attached."
fi

echo "===> 3. Installing Node.js 22 & PM2..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node.js version: $(node -v)"

sudo npm install -g pm2

echo "===> 4. Installing MongoDB Database Tools (mongodump / mongorestore)..."
if ! command -v mongodump &> /dev/null; then
  curl -fsSL https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2204-x86_64-100.10.0.deb -o /tmp/db-tools.deb || \
  curl -fsSL https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-100.10.0.deb -o /tmp/db-tools.deb
  sudo apt-get install -y /tmp/db-tools.deb
  rm -f /tmp/db-tools.deb
fi
echo "MongoDB Tools version: $(mongodump --version | head -n1)"

echo "===> 4.5 Installing & Starting MongoDB Community Server (Catalog Database)..."
if ! command -v mongod &> /dev/null; then
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
  sudo apt-get update
  sudo apt-get install -y mongodb-org
fi

sudo systemctl enable --now mongod
echo "MongoDB Server status: $(sudo systemctl is-active mongod)"

echo "===> 5. Preparing Application Directory..."
sudo mkdir -p "$APP_DIR"
sudo chown -R $USER:$USER "$APP_DIR"

# Symlink block volume storage into app data directory if needed
mkdir -p "$APP_DIR/data"
if [ -d "$MOUNT_POINT" ]; then
  sudo chown -R $USER:$USER "$MOUNT_POINT"
  ln -sf "$MOUNT_POINT" "$APP_DIR/data/storage"
fi

echo "===> Setup Complete!"
echo "Next step: Add .env file at $APP_DIR/.env with process variables (STORAGE_ROOT=$MOUNT_POINT)."
