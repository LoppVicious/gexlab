#!/usr/bin/env bash
# GEX Lab - reintenta crear la instancia Always Free (A1) en Oracle hasta que haya capacidad.
# Se ejecuta en Cloud Shell (consola de Oracle), que ya esta autenticado con tu cuenta.
# Para cancelarlo: Ctrl+C.
set -uo pipefail

NAME="gexlab"
OCPUS=1
MEM=6
WAIT=90            # segundos entre intentos
PUB="$HOME/gexlab.pub"

[[ -s "$PUB" ]] || { echo "Falta la clave publica en $PUB"; exit 1; }
ssh-keygen -lf "$PUB" >/dev/null 2>&1 || { echo "La clave de $PUB no es valida"; exit 1; }

C="${OCI_TENANCY:-}"
if [[ -z "$C" ]]; then
  C=$(oci iam availability-domain list --query 'data[0]."compartment-id"' --raw-output 2>/dev/null)
fi
[[ -n "$C" ]] || { echo "No encuentro el tenancy"; exit 1; }

AD=$(oci iam availability-domain list -c "$C" --query 'data[0].name' --raw-output)
SUB=$(oci network subnet list -c "$C" --all \
      --query "data[?\"display-name\"=='public subnet-gexlab-vcn'].id | [0]" --raw-output)
IMG=$(oci compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
      --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC --limit 1 \
      --query 'data[0].id' --raw-output)

for v in AD SUB IMG; do
  if [[ -z "${!v}" || "${!v}" == "null" ]]; then echo "No encuentro $v"; exit 1; fi
done
echo "Dominio: $AD"
echo "Subred:  $SUB"
echo "Imagen:  Ubuntu 24.04 (aarch64)"

# si ya existe (por ejemplo, si se relanza el script), no crear otra
EXIST=$(oci compute instance list -c "$C" --display-name "$NAME" \
        --query "data[?\"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output 2>/dev/null)
if [[ -n "$EXIST" && "$EXIST" != "null" ]]; then
  ID="$EXIST"; echo "La instancia $NAME ya existe."
else
  n=0
  while :; do
    n=$((n + 1))
    OUT=$(oci compute instance launch -c "$C" --availability-domain "$AD" --display-name "$NAME" \
          --shape VM.Standard.A1.Flex --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM}" \
          --image-id "$IMG" --subnet-id "$SUB" --assign-public-ip true \
          --ssh-authorized-keys-file "$PUB" --query 'data.id' --raw-output 2>&1)
    if [[ "$OUT" == ocid1.instance.* ]]; then
      ID="$OUT"; echo "$(date '+%d/%m %H:%M:%S')  intento $n: CREADA"; break
    fi
    if grep -qi "capacity" <<<"$OUT"; then
      echo "$(date '+%d/%m %H:%M:%S')  intento $n: sin capacidad, reintento en ${WAIT}s"; sleep "$WAIT"
    elif grep -qi "TooManyRequests\|429" <<<"$OUT"; then
      echo "$(date '+%d/%m %H:%M:%S')  intento $n: demasiadas peticiones, espero 5 min"; sleep 300
    elif grep -qi "LimitExceeded\|quota" <<<"$OUT"; then
      echo "Oracle indica que se supera el limite gratuito. Paro sin crear nada:"; echo "$OUT" | head -20; exit 1
    else
      echo "$(date '+%d/%m %H:%M:%S')  intento $n: error no esperado, reintento en ${WAIT}s"
      echo "$OUT" | grep -i '"message"' | head -2
      sleep "$WAIT"
    fi
  done
fi

echo "Esperando a que arranque..."
for _ in $(seq 1 40); do
  ST=$(oci compute instance get --instance-id "$ID" --query 'data."lifecycle-state"' --raw-output 2>/dev/null)
  [[ "$ST" == "RUNNING" ]] && break
  sleep 15
done
IP=$(oci compute instance list-vnics --instance-id "$ID" --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
echo
echo "=============================================="
echo " Instancia $NAME: $ST"
echo " IP publica: $IP"
echo "=============================================="
