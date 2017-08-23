import unittest
from core.scheduler import *
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from apscheduler.util import convert_to_datetime
import datetime
from tzlocal import get_localzone

class TestSchedulerUtils(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.datestr1 = '2017-10-30 12:03:36'
        cls.date1 = convert_to_datetime(cls.datestr1, get_localzone(), 'run_date')

    def test_construct_task_id(self):
        task_id_workflow_uid_pairs = {('task', 'work'): 'task-work',
                                      ('', 'work'): '-work',
                                      ('task', ''): 'task-'}
        for input_, output in task_id_workflow_uid_pairs.items():
            self.assertEqual(construct_task_id(*input_), output)

    def test_split_task_uid(self):
        task_id_workflow_uid_pairs = {'task-work': ['task', 'work'],
                                      '-work': ['', 'work'],
                                      'task-': ['task', '']}
        for input_, output in task_id_workflow_uid_pairs.items():
            self.assertListEqual(split_task_id(input_), output)

    def test_split_task_uid_too_many_sperators(self):
        uid = task_id_separator.join(['a', 'b', 'c'])
        task_id = construct_task_id('task', uid)
        self.assertListEqual(split_task_id(task_id), ['task', 'a'])

    def test_construct_date_scheduler(self):
        args = {'type': 'date', 'args': {'date': self.datestr1}}
        trigger = construct_scheduler(args)
        self.assertIsInstance(trigger, DateTrigger)
        self.assertEqual(trigger.run_date, self.date1)

    def test_construct_date_scheduler_invalid_date(self):
        args = {'type': 'date', 'args': {'date': '2017-14-30 12:03:36'}}
        with self.assertRaises(InvalidSchedulerArgs):
            construct_scheduler(args)

    def test_construct_date_scheduler_invalid_arg_structure(self):
        args = {'type': 'date', 'args': {'junk': '2017-11-30 12:03:36'}}
        with self.assertRaises(InvalidSchedulerArgs):
            construct_scheduler(args)

    def test_construct_interval_scheduler(self):
        args = {'type': 'date', 'args': {'date': self.datestr1}}
        trigger = construct_scheduler(args)
        self.assertIsInstance(trigger, DateTrigger)
        self.assertEqual(trigger.run_date, self.date1)

    def test_construct_date_scheduler_invalid_date(self):
        args = {'type': 'date', 'args': {'date': '2017-14-30 12:03:36'}}
        with self.assertRaises(InvalidSchedulerArgs):
            construct_scheduler(args)

    def test_construct_date_scheduler_invalid_arg_structure(self):
        args = {'type': 'date', 'args': {'junk': '2017-11-30 12:03:36'}}
        with self.assertRaises(InvalidSchedulerArgs):
            construct_scheduler(args)