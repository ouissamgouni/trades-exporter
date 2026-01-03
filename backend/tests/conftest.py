import tempfile
import os
import pytest

@pytest.fixture(scope="function")
def temp_db_path():
    db_fd, db_path = tempfile.mkstemp()
    yield db_path
    os.close(db_fd)
    os.remove(db_path)
