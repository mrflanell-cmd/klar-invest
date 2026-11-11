import unittest
from piercing_engine import Candle, scan_three

class TestPiercing(unittest.TestCase):
    def setUp(self):
        self.red = Candle("2026-11-02", 100, 102, 89, 90)
        self.confirm = Candle("2026-11-04", 100, 105, 99, 101)
    def test_classic(self):
        x = scan_three(self.red, Candle("2026-11-03", 89, 98, 87, 96), self.confirm)
        self.assertEqual(x["variant"], "classic")
        self.assertEqual(x["entry_limit"], 100)
        self.assertEqual(x["stop_loss"], 87)
        self.assertEqual(x["take_profit_2r"], 126)
        self.assertEqual(x["quantity"], 11)
    def test_mild(self):
        x = scan_three(self.red, Candle("2026-11-03", 89, 95, 87, 92), self.confirm)
        self.assertEqual(x["variant"], "mild")
    def test_no_confirmation(self):
        self.assertIsNone(scan_three(self.red, Candle("2026-11-03", 89, 98, 87, 96), Candle("2026-11-04", 99, 101, 95, 100)))
    def test_no_gap(self):
        self.assertIsNone(scan_three(self.red, Candle("2026-11-03", 90, 98, 87, 96), self.confirm))
    def test_no_wick_requirement(self):
        self.assertIsNotNone(scan_three(self.red, Candle("2026-11-03", 89, 98, 89, 96), self.confirm))
    def test_strict_midpoint(self):
        self.assertEqual(scan_three(self.red, Candle("2026-11-03", 89, 95, 87, 95), self.confirm)["variant"], "mild")
    def test_unaffordable(self):
        self.assertFalse(scan_three(self.red, Candle("2026-11-03", 89, 98, 87, 96), self.confirm, max_purchase_sek=50)["tradable"])
if __name__ == "__main__":
    unittest.main()
