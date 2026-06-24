import yaml
import sys
import secrets
import os

config_path = '/opt/data/config.yaml'
env_path = '/opt/data/.env'

# Generate a secure random API key
api_key = secrets.token_hex(32)

# 1. Update config.yaml
try:
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f) or {}
except Exception as e:
    print(f"Error reading config.yaml: {e}")
    sys.exit(1)

if 'platforms' not in config or config['platforms'] is None:
    config['platforms'] = {}

config['platforms']['api_server'] = {
    'enabled': True,
    'extra': {
        'port': 8642,
        'host': '0.0.0.0',
        'key': api_key
    }
}

try:
    with open(config_path, 'w') as f:
        yaml.safe_dump(config, f, default_flow_style=False, sort_keys=False)
    print("✓ Updated config.yaml with api_server enabled and secure key.")
except Exception as e:
    print(f"Error writing config.yaml: {e}")
    sys.exit(1)

# 2. Update .env file
env_lines = []
if os.path.exists(env_path):
    with open(env_path, 'r') as f:
        env_lines = f.readlines()

# Remove existing API_SERVER_KEY if present to avoid duplicates
env_lines = [line for line in env_lines if not line.startswith('API_SERVER_KEY=')]

# Append the new key
env_lines.append(f"\nAPI_SERVER_KEY={api_key}\n")

try:
    with open(env_path, 'w') as f:
        f.writelines(env_lines)
    print(f"✓ Appended API_SERVER_KEY to {env_path}")
    print("\nSuccessfully configured API Server!")
    print(f"Generated API Key: {api_key}")
except Exception as e:
    print(f"Error writing .env file: {e}")
    sys.exit(1)
