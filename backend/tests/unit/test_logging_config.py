from backend.config.loader import configure_logging


def test_positional_args_are_interpolated(capsys):
    """Regression: %s placeholders were rendered raw with a positional_args field."""
    configure_logging("test_logging").warning(
        "sync rejected for job %s from %s", 802, "ui"
    )

    err = capsys.readouterr().err
    assert "sync rejected for job 802 from ui" in err
    assert "positional_args" not in err
