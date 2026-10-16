import io
import logging
import os
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest
from asn1crypto import x509 as a_x509
from conftest import CABECERAS, crear_cliente, png
from firmas_digitales import a_asn1, a_pem, agregar_cambio_posterior, crear_ca, emitir, firmar

from firmas_ocr.errores import DocumentoNoProcesable, Plazo
from firmas_ocr.firma_electronica import extraer_identificacion, validar_pdf
from firmas_ocr.raices import cargar_certificados, cargar_raices

logging.getLogger('pyhanko').setLevel(logging.CRITICAL)


@pytest.fixture(scope='module')
def ca():
    return crear_ca()


@pytest.fixture(scope='module')
def pdf_base():
    documento = pdfium.PdfDocument.new()
    documento.new_page(200, 300)
    salida = io.BytesIO()
    documento.save(salida)
    return salida.getvalue()


@pytest.fixture(scope='module')
def firmado(ca, pdf_base):
    return firmar(pdf_base, emitir(ca, 'MARCO ALBAN PRUEBA', '1712345678'), ca)


def validar(datos, *raices):
    return validar_pdf(datos, list(raices), Plazo(60))


def test_pdf_sin_firmas(pdf_base):
    r = validar(pdf_base)
    assert r.estado == 'sin_firmas_digitales' and r.firmas == []


def test_firma_verificada_con_raiz_cargada(firmado, ca):
    r = validar(firmado, a_asn1(ca[0]))
    f = r.firmas[0]
    assert r.estado == 'verificado'
    assert f.integridad.estado == 'intacto' and f.integridad.cobertura == 'archivo_completo'
    assert f.firmante.nombre == 'MARCO ALBAN PRUEBA'
    assert f.firmante.identificacion == '1712345678'
    assert f.emisor.nombre == 'RAIZ DE PRUEBA'
    assert f.vigente_al_firmar is True and f.fecha_firma
    assert f.cadena.reconocida and f.cadena.entidad == 'RAIZ DE PRUEBA'
    assert f.firmante_verificado and f.conclusion == 'Firmante verificado.'


def test_responde_sin_raices_como_firmante_no_verificado(firmado):
    r = validar(firmado)
    f = r.firmas[0]
    assert r.estado == 'firmantes_no_verificados'
    assert f.integridad.estado == 'intacto'  # el documento sí está íntegro
    assert not f.cadena.reconocida and not f.firmante_verificado
    assert 'no verificado' in f.conclusion
    # El PDF dice usar esta raíz, pero no es de confianza mientras no esté cargada.
    assert f.cadena.raiz_declarada_en_pdf.nombre == 'RAIZ DE PRUEBA'


def test_raiz_ajena_no_reconoce_la_cadena(firmado):
    otra, _ = crear_ca('OTRA RAIZ')
    r = validar(firmado, a_asn1(otra))
    assert not r.firmas[0].cadena.reconocida
    assert r.estado == 'firmantes_no_verificados'


def test_certificado_no_vigente_al_firmar(ca, pdf_base):
    vencido = emitir(ca, 'VENCIDO PRUEBA', '1700000001', desde_dias=-400, hasta_dias=-10)
    f = validar(firmar(pdf_base, vencido, ca), a_asn1(ca[0])).firmas[0]
    assert f.vigente_al_firmar is False
    assert not f.firmante_verificado
    assert 'no estaba vigente' in ' '.join(f.advertencias)


def test_alterado_con_cambio_posterior(firmado, ca):
    r = validar(agregar_cambio_posterior(firmado), a_asn1(ca[0]))
    f = r.firmas[0]
    assert f.integridad.firma_valida  # la firma sigue siendo correcta para lo que firmó
    assert f.integridad.cobertura == 'revision'
    assert f.integridad.estado == 'modificado_despues_de_firmar'
    assert r.estado == 'alterado'

def test_alterado_por_bytes_modificados(firmado, ca):
    datos = bytearray(firmado)
    datos[7] ^= 0x01  # un byte de la cabecera (%PDF-1.x), dentro del contenido firmado
    r = validar(bytes(datos), a_asn1(ca[0]))
    assert r.estado == 'alterado'
    assert r.firmas[0].integridad.estado == 'firma_invalida'
    assert not r.firmas[0].integridad.documento_intacto


def test_dos_firmas_la_primera_con_revision_posterior(ca, pdf_base):
    una = firmar(pdf_base, emitir(ca, 'PRIMERO PRUEBA', '1700000002'), ca, 'Firma1')
    dos = firmar(una, emitir(ca, 'SEGUNDO PRUEBA', '1700000003'), ca, 'Firma2')
    r = validar(dos, a_asn1(ca[0]))
    assert [f.firmante.nombre for f in r.firmas] == ['PRIMERO PRUEBA', 'SEGUNDO PRUEBA']
    assert r.firmas[0].integridad.estado == 'intacto_con_revisiones_posteriores'
    assert r.firmas[1].integridad.estado == 'intacto'
    assert r.estado == 'verificado'


def test_pdf_corrupto():
    with pytest.raises(DocumentoNoProcesable):
        validar(b'%PDF-1.4 basura sin estructura')


@pytest.mark.parametrize(
    'serie, esperado',
    [('0401686662-140126144519', '0401686662'), ('1712517984', '1712517984'), ('RUC 1790012345001', '1790012345001')],
)
def test_identificacion_desde_serial_number(serie, esperado):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.x509.oid import NameOID
    from datetime import datetime, timedelta, timezone
    from firmas_digitales import _llave

    llave = _llave()
    nombre = x509.Name([x509.NameAttribute(NameOID.SERIAL_NUMBER, serie), x509.NameAttribute(NameOID.COMMON_NAME, 'X')])
    cert = (
        x509.CertificateBuilder().subject_name(nombre).issuer_name(nombre).public_key(llave.public_key())
        .serial_number(1).not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1)).sign(llave, hashes.SHA256())
    )
    assert extraer_identificacion(a_asn1(cert)) == esperado


def test_cargar_raices_acepta_pem_y_omite_basura(tmp_path, ca):
    (tmp_path / 'valida.pem').write_bytes(a_pem(ca[0]))
    (tmp_path / 'rota.crt').write_bytes(b'esto no es un certificado')
    (tmp_path / 'notas.txt').write_text('ignorado')
    assert len(cargar_raices(str(tmp_path))) == 1
    intermedia = emitir(ca, 'INTERMEDIA NO RAIZ', '1700000009')[0]
    (tmp_path / 'inter.pem').write_bytes(a_pem(intermedia))
    raices, intermedias = cargar_certificados(str(tmp_path))
    assert len(raices) == 1 and len(intermedias) == 1  # solo lo autofirmado es raíz
    assert cargar_raices(str(tmp_path / 'no_existe')) == []


def test_raiz_de_anf_incluida_en_el_repositorio():
    raices = cargar_raices(str(Path(__file__).resolve().parents[1] / 'raices'))
    nombres = {r.subject.native['common_name'] for r in raices}
    assert 'ANF High Assurance Ecuador Root CA' in nombres
    assert 'ANF High Assurance Ecuador Intermediate CA' not in nombres  # no es ancla de confianza


# --- API -------------------------------------------------------------------------------


@pytest.fixture
def cliente_con_raiz(tmp_path, ca):
    (tmp_path / 'raiz.pem').write_bytes(a_pem(ca[0]))
    with crear_cliente(raices_dir=str(tmp_path)) as c:
        yield c


def post(cliente, datos, nombre='doc.pdf', cabeceras=CABECERAS):
    return cliente.post(
        '/v1/firma-electronica', headers=cabeceras, files={'archivo': (nombre, datos, 'application/pdf')}
    )


def test_api_firma_verificada(cliente_con_raiz, firmado):
    r = post(cliente_con_raiz, firmado)
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo['estado'] == 'verificado' and cuerpo['raices_cargadas'] == 1
    assert cuerpo['revocacion'] == 'no_verificada'
    assert cuerpo['firmas'][0]['firmante']['identificacion'] == '1712345678'
    assert 'no reemplaza' in cuerpo['aviso']


def test_api_responde_aunque_falte_la_cadena(sin_ocr, firmado, tmp_path):
    with crear_cliente(raices_dir=str(tmp_path)) as c:  # carpeta sin raíces
        r = post(c, firmado)
        assert c.get('/salud').json()['raices_cargadas'] == 0
    assert r.status_code == 200
    assert r.json()['estado'] == 'firmantes_no_verificados'
    assert 'no verificado' in r.json()['firmas'][0]['conclusion']


def test_api_documento_alterado(cliente_con_raiz, firmado):
    r = post(cliente_con_raiz, agregar_cambio_posterior(firmado))
    assert r.json()['estado'] == 'alterado'


def test_api_pdf_sin_firmas(cliente_con_raiz, pdf_base):
    assert post(cliente_con_raiz, pdf_base).json()['estado'] == 'sin_firmas_digitales'


def test_api_errores(cliente_con_raiz, firmado):
    assert post(cliente_con_raiz, firmado, cabeceras={}).status_code == 401
    assert post(cliente_con_raiz, b'').status_code == 400
    assert post(cliente_con_raiz, png(np.zeros((50, 50, 3), np.uint8))).status_code == 415
    assert post(cliente_con_raiz, b'texto plano').status_code == 415
    assert post(cliente_con_raiz, b'%PDF-1.4 roto').status_code == 422
    assert cliente_con_raiz.post('/v1/firma-electronica', headers=CABECERAS).status_code == 400


def test_api_413(firmado, tmp_path):
    with crear_cliente(max_bytes=500, raices_dir=str(tmp_path)) as c:
        assert post(c, firmado).status_code == 413


def test_api_504(firmado, tmp_path):
    with crear_cliente(timeout_s=0.000001, raices_dir=str(tmp_path)) as c:
        assert post(c, firmado).status_code == 504


# --- documentos reales de FirmaEC (se omiten si no están montados) ----------------------------

SOPORTES = Path(os.environ.get('FIRMAS_OCR_SOPORTES', '/soportes'))
real = pytest.mark.skipif(not SOPORTES.is_dir(), reason='SOPORTES EJEMPLO no está disponible')
RAICES = Path(__file__).resolve().parents[1] / 'raices'


def _pdf_real(patron: str) -> bytes:
    return next(SOPORTES.rglob(patron)).read_bytes()


@real
def test_real_firmaec_dos_firmantes_con_anf_verificado():
    datos = _pdf_real('3836_EDYL-013_GUIA-signed-signed.pdf')
    raices, intermedias = cargar_certificados(str(RAICES))
    r = validar_pdf(datos, raices, Plazo(60), intermedias)
    primera, segunda = r.firmas
    assert (primera.firmante.nombre, primera.firmante.identificacion) == ('IRVIN DAVID CORAL FIERRO', '0401686662')
    assert 'SECURITY DATA' in primera.emisor.nombre
    assert primera.integridad.estado == 'intacto_con_revisiones_posteriores'
    assert segunda.firmante.identificacion == '1717527483'
    assert segunda.integridad.estado == 'intacto' and segunda.vigente_al_firmar is True
    # Raíz de ANF cargada: su firmante queda verificado; Security Data no (raíz pendiente).
    assert segunda.firmante_verificado and segunda.cadena.entidad == 'ANF High Assurance Ecuador Root CA'
    assert not primera.firmante_verificado
    assert primera.cadena.raiz_declarada_en_pdf.nombre.startswith('AUTORIDAD DE CERTIFICACION RAIZ CA-2')
    assert r.estado == 'firmantes_no_verificados'


@real
def test_real_firmaec_modificado_despues_de_firmar():
    datos = _pdf_real('3836_EDYL-013_GUIA-signed-signed.pdf')
    r = validar_pdf(agregar_cambio_posterior(datos), cargar_raices(str(RAICES)), Plazo(60))
    assert r.estado == 'alterado'
    assert r.firmas[-1].integridad.estado == 'modificado_despues_de_firmar'
    assert r.firmas[-1].integridad.cobertura == 'revision'
    assert all(f.integridad.estado == 'modificado_despues_de_firmar' for f in r.firmas)
    assert not any(f.firmante_verificado for f in r.firmas)


@real
def test_real_firmaec_con_bytes_alterados():
    datos = bytearray(_pdf_real('3836_EDYL-013_GUIA-signed-signed.pdf'))
    inicio = datos.index(b'stream') + 40
    datos[inicio] ^= 0xFF
    r = validar_pdf(bytes(datos), cargar_raices(str(RAICES)), Plazo(60))
    assert r.estado == 'alterado'
    assert any(f.integridad.estado == 'firma_invalida' for f in r.firmas)


@real
def test_real_todos_los_ejemplos_firmados_responden():
    raices, intermedias = cargar_certificados(str(RAICES))
    vistos = 0
    for pdf in SOPORTES.rglob('*.pdf'):
        r = validar_pdf(pdf.read_bytes(), raices, Plazo(60), intermedias)
        if r.firmas:
            vistos += 1
            assert r.estado in ('firmantes_no_verificados', 'verificado', 'verificado_con_advertencias', 'alterado')
            assert all(f.firmante.identificacion for f in r.firmas), pdf.name
    assert vistos >= 20
