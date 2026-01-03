#!/usr/bin/env python3
"""
Test structure validation script.
Runs different test categories to validate the organized structure.
"""

import subprocess
import sys
import os

def run_command(cmd, description):
    """Run a command and return success status."""
    print(f"\n{'='*60}")
    print(f"🧪 {description}")
    print(f"{'='*60}")
    print(f"Command: {cmd}")
    print()
    
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(__file__)))
        
        if result.returncode == 0:
            print("✅ SUCCESS")
            if result.stdout:
                print(result.stdout)
        else:
            print("❌ FAILED")
            if result.stderr:
                print("STDERR:", result.stderr)
            if result.stdout:
                print("STDOUT:", result.stdout)
                
        return result.returncode == 0
        
    except Exception as e:
        print(f"❌ EXCEPTION: {e}")
        return False

def main():
    """Run test validation."""
    print("🚀 Test Structure Validation")
    
    tests = [
        ("python -m pytest tests/unit/connectors/exchanges/ --collect-only", 
         "Collect Unit Tests - Exchange Connectors"),
        
        ("python -m pytest tests/integration/web3/ --collect-only", 
         "Collect Integration Tests - Web3"),
         
        ("python -m pytest tests/unit/ --collect-only -k 'not slow'", 
         "Collect Fast Unit Tests"),
         
        ("python -m pytest tests/ --collect-only -m 'not slow'", 
         "Collect All Non-Slow Tests"),
    ]
    
    results = []
    for cmd, desc in tests:
        success = run_command(cmd, desc)
        results.append((desc, success))
    
    # Summary
    print(f"\n{'='*60}")
    print("📊 SUMMARY")
    print(f"{'='*60}")
    
    for desc, success in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} - {desc}")
    
    total_success = sum(1 for _, success in results if success)
    print(f"\nTotal: {total_success}/{len(results)} tests passed")
    
    if total_success == len(results):
        print("🎉 All test structure validations passed!")
        return 0
    else:
        print("⚠️  Some validations failed - check test structure")
        return 1

if __name__ == "__main__":
    sys.exit(main())