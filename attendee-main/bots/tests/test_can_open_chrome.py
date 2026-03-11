import os

from django.test.testcases import TransactionTestCase
from pyvirtualdisplay import Display
from selenium import webdriver
from selenium.webdriver.chrome.service import Service


class TestChromeDriver(TransactionTestCase):
    def test_can_open_google(self):
        # Create virtual display if no real display is available
        if os.environ.get("DISPLAY") is None:
            display = Display(visible=0, size=(1920, 1080))
            display.start()

        try:
            # Set up Chrome options
            options = webdriver.ChromeOptions()
            options.add_argument("--use-fake-ui-for-media-stream")
            options.add_argument("--start-maximized")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-gpu")
            options.add_argument("--disable-extensions")
            options.add_argument("--disable-application-cache")
            options.add_argument("--disable-setuid-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-blink-features=AutomationControlled")
            # Initialize Chrome driver
            driver = webdriver.Chrome(options=options, service=Service(executable_path="/usr/local/bin/chromedriver"))

            try:
                # Load Google
                driver.get("https://www.google.com")

                # Verify we can find the Google search box
                search_box = driver.find_element("name", "q")

                # Basic assertion that we found the search box
                self.assertIsNotNone(search_box)

            finally:
                # Clean up driver
                driver.quit()

        except Exception as e:
            self.fail(f"Failed to open Chrome and load Google: {str(e)}")
