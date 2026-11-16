import unittest
from app import unified_patterns

def bar(o,h,l,c,date="2026-11-13"):
    return {"open":o,"high":h,"low":l,"close":c,"date":date}

class UnifiedPatternsTest(unittest.TestCase):
    def test_piercing_confirmation(self):
        bars=[bar(100,103,89,90),bar(88,98,86,96),bar(98,107,95,102)]
        self.assertIn("three_candles",[p[0] for p in unified_patterns(bars)])
    def test_green_inside_confirmation(self):
        bars=[bar(100,105,85,90),bar(92,99,88,97),bar(100,109,96,102)]
        self.assertIn("inside_bar",[p[0] for p in unified_patterns(bars)])
    def test_bearish_engulfing_no_confirmation(self):
        bars=[bar(100,112,96,110),bar(112,114,94,98),bar(98,103,95,99)]
        # Bearish engulfing must be on the latest TWO candles.
        self.assertNotIn("bearish_engulfing",[p[0] for p in unified_patterns(bars)])
        bars=[bar(95,99,90,97),bar(100,112,96,110),bar(112,114,94,98)]
        self.assertIn("bearish_engulfing",[p[0] for p in unified_patterns(bars)])
    def test_no_false_signal(self):
        self.assertEqual(unified_patterns([bar(100,110,90,95)]*3),[])

if __name__=="__main__":
    unittest.main()
