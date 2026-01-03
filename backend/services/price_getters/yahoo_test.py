import yfinance as yf
import requests_cache
import pandas_datareader.data as web
import datetime as dt

if __name__ == "__main__":
    ticker = "AAPL"
    '''session = requests_cache.CachedSession(
        cache_name="yfinance_cache",
        backend="sqlite",
        expire_after=3600  # 1 hour
    )
    session.headers.update({
    "User-Agent": "curl/7.68.0"
    })
    stock = yf.Ticker(ticker)
    #stock = yf.Ticker(ticker, session=session)
    print(stock.info)
    history = stock.history(period="5d")
    df = yf.download(
    "AAPL",
    period="1mo",
    #session=session,
    progress=False
    ) '''
    start = dt.datetime(2024, 1, 1)
    end = dt.datetime.now()

    df = web.DataReader("AAPL", "stooq", start, end)
    print(df.head())
    print(df.size)