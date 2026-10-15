"""A deliberately unsafe handler. The extension's tests point events at it."""
import logging
import os

log = logging.getLogger(__name__)


def ping_host(request):
    host = request.args['host']
    log.info('ping %s', host)

    os.system("ping -c 1 " + host)
